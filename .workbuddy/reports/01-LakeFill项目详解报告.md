# LakeFill 数据湖填表项目详解报告

> 项目来源：G:\EgDownload\Retrieval_Augmented_Imputation-main
> 分析日期：2026-04-26

---

## 一、项目概述

**LakeFill** 是一个**检索增强的数据填补**（Retrieval-Augmented Imputation）框架，发表论文针对的核心问题是：

> 当表格内数据冗余不足（无法依靠表内关系推断缺失值）时，如何借助外部数据湖（Data Lake）完成缺失值的智能填补？

### 1.1 问题背景

传统数据填补方法依赖表内关系（如函数依赖、缺失值与已有值的统计关联），但当缺失比例高、表内信息稀疏时，这些方法效果很差。LakeFill 提出一个新范式：**将外部数据湖作为知识源，用 RAG 思路填补缺失值**。

### 1.2 核心思想

```
Query Tuple（缺失值） + Data Lake（外部知识） → 检索 → 重排 → LLM 填充
```

本质上是把**数据库表填充问题**转化为了**问答+RAG问题**来处理。

---

## 二、系统架构

LakeFill 采用**三阶段 Pipeline**：

```
┌─────────────────────────────────────────────────────────────────┐
│                     LakeFill 三阶段架构                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Stage 1: Retrieval         Stage 2: Reranking      Stage 3: Imputation
│  ─────────────────         ─────────────────      ─────────────────
│  BM25 + Dense Retrieval    BERT Reranker          LLM 两阶段置信度填充
│  (Siamese Network)         (Checklist-based       (Strict vs Relaxed)
│  Hard Negatives             Annotation Training)     Confidence Scoring)
│  Top-K=50 → Top-5          Top-5 → Top-1          自动决定填充 or 留空
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、Stage 1 — 检索层（Retriever）

### 3.1 Siamese Network 架构

```python
# retriever/src/dense.py
class SiameseRetriever(DenseRetriever):
    def __init__(self, ...):
        # BERT-based Encoder: (query, positive/negative) → 768-dim vector
        # Loss: Contrastive Learning = 同一 query 的正例靠近，负例远离
        selfEmbedding_model = BERT(768)
```

**训练策略**：
- 正例（positive）：与 query 属于同一实体的 tuple
- 负例（negative）：**Hard Negatives** — BM25 高分但实际不相关的 tuple（比随机负例更难区分，训练效果更好）
- `num_hard_negatives=7, num_positives=1`
- `max_seq_len=256, embedding_dim=768`

### 3.2 检索流程

```
查询 tuple（带 N/A 缺失标记）
        ↓
BM25 粗召回 Top-50
        ↓
Siamese Encoder 向量化
        ↓
FAISS/Annoy 最近邻检索 → Top-5 候选
        ↓
输出：query_id → [candidate_tuple_1, ..., candidate_tuple_5]
```

**为什么用 Siamese Network 而不是直接 BERT 编码**：
- 对比学习可以让编码器学习"哪些 tuple 属于同一实体"，而不只是"哪些词相似"
- 特别适合**实体对齐**场景（tuples 格式相同但实体不同）

---

## 四、Stage 2 — 重排层（Reranker）

### 4.1 核心问题

检索层返回 Top-5 候选，如何选出最合适的那一个？

候选之间往往差别很小：
- 候选A：Scott Kent, Yukon Party, Riverdale North（正确）
- 候选B：Scott Kent, Liberal Party, Riverdale North（部分错误）
- 候选C：Scott Kent Jr., Yukon Party, Riverdale North（混淆人名）

需要一个**细粒度判断**能力，这不是向量检索擅长的。

### 4.2 Checklist-Based Annotation

```python
# reranking/annotation/construct_training_groups.py
prompt_template = '''
评估候选 Tuple 是否能填补 Query Tuple 的缺失值，从三个维度评估：

### Dimensions:
1. Existence:
   - Response Options: Yes, No
   - 候选 Tuple 是否包含 Query 中标记为 N/A 的缺失属性？

2. Relevance:
   - Response Options: Highly Relevant, Somewhat Relevant, Not Relevant
   - 候选 Tuple 与 Query 描述同一或相关实体的程度？

3. Logical Consistency:
   - Response Options: Fully Consistent, Partially Consistent, Not Consistent
   - 候选数据与 Query 在时间/逻辑上是否一致？
'''
```

### 4.3 训练数据构造

每个训练组 = **1 个正例 + 15 个负例**

```python
# 正例：确实能填补 Query 的候选
{ "query_id": 1, "candidate_id": 100, "label": 1, "scores": {existence:Yes, relevance:Highly, consistency:Fully} }

# 负例：不能填补的候选（混合策略）
# 负例1：Existence=No（缺少目标属性）
# 负例2：Relevance=Not Relevant（实体不相关）
# 负例3：Logical Consistency=Not Consistent（时间/逻辑矛盾）
```

### 4.4 BERT Reranker 训练

```python
# reranking/reranker/train.py
# 使用 BERT Cross-Encoder 对 (query, candidate) pair 打分
# 训练目标：二分类（正例=1，负例=0）
# 评估指标：Success@K（K=1,5,10,20,50,100）
```

**为什么用 BERT 而非直接向量相似度**：
- BERT 可以捕捉 query 和 candidate 之间**细粒度的词级交互**
- "Scott Kent" vs "Scott Kent Jr." — 只有一个词的差别，BERT 可以区分

---

## 五、Stage 3 — 填充层（Imputation）

### 5.1 两阶段置信度填充

这是 LakeFill 最核心的设计创新。

```python
class Imputer:
    def process_query(self, qid):
        # ========== Strict Mode ==========
        # 只用检索结果中的显式证据
        # 不允许 LLM 用自身知识推断
        # 要求：候选 tuple 必须包含目标属性的直接值
        strict_predictions, strict_confidences = self.impute_value(qid, 'strict')

        # ========== Relaxed Mode ==========
        # 允许 LLM 结合上下文推断
        # 当 Strict Mode 置信度 < threshold 时触发
        if max(strict_confidences.values()) < self.args.threshold:
            relaxed_predictions = self.impute_value(qid, 'relaxed')
            return self.merge(strict_predictions, relaxed_predictions, strict_confidences)

        return strict_predictions
```

### 5.2 置信度评分体系

LakeFill 实现了**三种互补的置信度评分**：

#### (a) LLM Self-Confidence

```python
# LLM 输出时附带置信度：
{
  "论文名称": {
    "imputed_value": "Deep Learning for...",
    "confidence": 0.85
  }
}
```

#### (b) NLN（Length-Normalized Logprob）

```python
def length_normalized_confidence(self, log_probs: list[float]) -> float:
    """
    基于 token log probabilities 计算
    几何平均 + 长度归一化
    L = token 数量
    confidence = exp(Σlogp_i / L)  ∈ [0, 1]
    """
    L = len(log_probs)
    confidence = np.exp(sum(log_probs) / L)
    return confidence
```

**为什么用几何平均而不是算术平均**：
- 几何平均对个别极低概率的 token 更敏感
- 如果有一个 token 的 logp = -10（概率 0.00005），算术平均影响小，但几何平均会把整体置信度拉低很多

#### (c) Entropy-Based Confidence

```python
def calculate_entropy(self, top_logprobs_list: list) -> float:
    """
    对每个 token 的 top-K 分布计算熵
    H(token_i) = -Σ p_j * log(p_j)
    低熵 = 模型对当前 token 很确定
    confidence = exp(-avg_entropy)
    """
    entropies = [self.token_entropy(tok) for tok in top_logprobs_list]
    avg_entropy = mean(entropies)
    confidence = np.exp(-avg_entropy)
    return confidence
```

### 5.3 三种置信度的对比

| 维度 | LLM Self | NLN | Entropy |
|------|----------|-----|---------|
| 依赖 | LLM 直接输出 | 需要 logprobs | 需要 top-K 分布 |
| 优点 | 直观 | 有数学基础 | 对"犹豫"敏感 |
| 缺点 | LLM 可能过度自信 | 长文本天然偏低 | 需要概率分布 |
| 适用场景 | 快速自评 | API 支持时 | 推理过程分析 |

### 5.4 阈值策略

```python
# impute.py
THRESHOLD = 0.9  # 硬阈值

# 填充决策：
confidence >= 0.9 → 直接采用
0.7 <= confidence < 0.9 → 标记 [Low Confidence]，仍填充
confidence < 0.7 → 留空或要求人工确认
```

### 5.5 实体等价性验证（Verification Cache）

```python
# impute.py
class EntityVerifier:
    def __init__(self):
        self.cache = self.load_cache("verification_cache.json")
        # cache key: (entity_a, entity_b) → True/False

    def verify(self, prediction, answer_set) -> bool:
        """判断预测值和答案是否指向同一实体"""
        # "New York City" == "NYC" → True
        # "IEEE" == "Institute of Electrical..." → True
        # "MLLM" == "Multi-Modal LLM" → False（近似但不等价）
        cache_key = (prediction, answer_set)
        if cache_key in self.cache:
            return self.cache[cache_key]

        result = self.llm_judge_equivalence(prediction, answer_set)
        self.cache[cache_key] = result
        self.save_cache()
        return result
```

**缓存机制**避免了对同一实体对的重复 LLM 调用。

---

## 六、训练与评估

### 6.1 训练数据集

| 数据集 | 描述 |
|--------|------|
|餐厅数据集 | 餐馆信息表，含名称/地址/菜系等 |
|Yelp | 商业评论数据 |
|DBLP | 学术论文数据 |

### 6.2 评估指标

```python
# reranking/reranker/train.py
def calculate_success(topk_pids, qrels, K):
    """
    Success@K = 在 Top-K 检索结果中至少有一个正确答案的 Query 比例
    """
    for K in [1, 5, 10, 20, 50, 100]:
        success = sum(relevant_docs.intersection(topK_docs)) / count
        print(f"Success@{K} = {success:.3f}")
```

### 6.3 端到端评估

```python
# impute.py
# 对每个缺失值字段，评估：
# 1. 能否检索到相关候选（检索召回率）
# 2. 能否正确排序最优候选（重排精确率）
# 3. LLM 填充是否正确（填充准确率）
# 4. 置信度是否符合真实质量（校准度）
```

---

## 七、技术栈总结

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 向量检索 | FAISS / Annoy | 近似最近邻 |
| Embedding | BERT-base-uncased | 768维 Siamese |
| 重排模型 | BERT Cross-Encoder | 二分类 |
| LLM | GPT-4o | 填充 + 验证 |
| 标注 | GPT-4 (few-shot) | Checklist 三维度 |
| 训练框架 | HuggingFace Transformers | Trainer |
| 缓存 | JSON 文件 | 实体等价验证 |

---

## 八、核心创新点总结

| 创新点 | 解决的问题 | 可迁移性 |
|--------|----------|---------|
| **Strict vs Relaxed 双模式** | LLM 幻觉 vs 信息不足的矛盾 | 强 |
| **三维度候选评估** | 检索结果质量的细粒度判断 | 强 |
| **NLN + Entropy 置信度** | LLM 输出质量的客观量化 | 中 |
| **Verification Cache** | 实体等价判断的重复调用开销 | 强 |
| **Hard Negative Mining** | 对比学习训练效果提升 | 中 |
| **Checklist Annotation** | 重排训练数据的高效构造 | 中 |

---

## 九、局限性

1. **依赖外部数据湖**：如果数据湖中没有相关实体，检索天然失败
2. **实体对齐问题**：不同数据源的实体表示方式不同（"IEEE" vs "Institute of..."）
3. **冷启动问题**：新实体没有足够训练数据做 Siamese Network
4. **LLM 幻觉仍存在**：Relaxed Mode 下仍可能产生错误推断
5. **阈值人工设定**：0.9 的阈值需要根据场景调优
