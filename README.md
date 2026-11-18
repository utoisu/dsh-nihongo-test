# dsh-nihongo-test

给 [DeepSeek Harness](https://github.com/) 用的日语笔译模考插件：五个题库、自由组卷、计时考试、客观题自动判分、实务题 AI 双评/三评，外加错题库和成绩单。

做的过程中对着 CATTI 日语笔译二级真题和几本教材整理过题库，所以数据模型是按「词汇 / 语法 / 阅读理解 / 日译中 / 中译日」这五类来的，但插件本身不绑定任何特定语料——题库是你自己的，存在本地 JSON 文件里。

> 分数是模拟分：用来定位薄弱环节，不等于官方 CATTI 评分。

---

## 功能

### 题库

- 五个库：`vocab` 词汇、`grammar` 语法、`reading` 阅读理解、`ja2zh` 日译中、`zh2ja` 中译日。
- 每道题都带来源、难度（L1–L3）、题材、标签、答案来源与状态。
- 每条可以打状态：`active` 在库（参与组卷）、`candidate` 候选、`needs_human` 待人工、`disputed` 争议、`rejected` 已拒。
- 分类维度：**真题 / 模拟 / 教材**（`exam_kind`）、**年份**（`year`）、**二笔 / 三笔**（`level`）。
- 列表能按题型、状态、性质、级别、错题、关键字筛，每页 100 条带翻页。
- **人工改题**：题干、选项、答案、语法点、解析、译文、标题、题材、难度都能改；保存前弹确认框，列清楚这次改了哪几个字段，确认才落盘。改内容不动状态和批次。

### 导入

- 粘贴文本或选文件，先「解析预览」（只解析不写盘），勾选后再入库，入库一律是候选。
- 认三种格式：Markdown 题目格式、JSON、以及 `translation-drill` 语料库（把长段切成整篇的翻译题）。
- 去重两层：严格 hash（题干/选项/原文去空白相同）+ 宽松 hash（再忽略全半角、标点），重复题自动拒收。
- 清洗规则：剥掉「本文选自：」「（出处：…）」「※ 编者按」这类注记和 OCR 残留的 LaTeX；选项不齐、答案覆盖不到整块的题块直接丢，不猜。
- 没答案的题自动进「待人工」。

### 组卷

- 三个模板：

  | 模板 | 时长 | 满分 | 结构 |
  | --- | --- | --- | --- |
  | 综合 | 120 分钟 | 100 | 词汇 10 + 语法 40 + 阅读理解 25 题 |
  | 实务 | 180 分钟 | 100 | 日译中 3 段 + 中译日 3 段 |
  | 全卷 | 300 分钟 | 200 | 综合 + 实务 |

- 也能自由组卷：自己配每类的题量和分值。
- 预览和建卷用同一个 seed，看到什么就考什么；题不够就报缺口，不硬凑。
- 可以只从**错题库**抽，也可以按年份一键建整卷（「按年份建套卷」）。
- 试卷存的是**题目快照**，之后怎么改题库都不影响已建好的卷。
- 默认排除最近 5 份试卷 / 成绩单用过的题；错题组卷不受这条限制。

### 考试

- 倒计时在服务端走，离开页面再回来接着考；能暂停、继续，次数不限，暂停时长不计入用时。
- 答案边答边存，刷新或断线恢复后还在。
- 时间到自动交卷，成绩单里注明是自动交的。

### 判分

- **客观题自动判**：词汇、语法、阅读，成绩单逐题给对错、正确答案、解析。
- **实务题 AI 双评**：两套独立评分（A/B），分差在阈值（默认 3 分）内取均值；超了要第三评（C），三评取均值。每段记分项分（忠实/通顺/术语/格式）、采分点逐条判定、问题清单。
- 两条判分入口，写同一种评审记录：
  - 页面上的「**一键批改**」：插件内直接调宿主的 `llm` 服务，每段问两次（必要时第三次），后台任务 + 进度轮询。
  - 会话内路径：`catti_grade material` 拿材料 → 主会话起子智能体评分 → `catti_grade commit` 写回。
- 一键批改的调用固定把 `reasoningEffort` 压到 `low`。默认档位若是 `max`，模型会把 token 全烧在推理上、正文一个字都拿不到（这个坑踩过，记在下面「已知问题」）。

### 成绩单与错题库

- 成绩单：总分、通过线（60%）、各节得分、用时、暂停统计、争议题清单、实务待判状态，可导出 Markdown。
- 实务部分按题对照：**原文 / 你的译文 / 参考译文** 三栏并排，上面是批改意见块。
- **错题库**：交卷时把答错的客观题自动登记（同一题再错加次数）；题库能「只看错题」，组卷能「只抽错题」。阅读按整篇登记（一篇里错一题就整篇进错题库）。

### Agent 工具

插件注册六个工具，和页面走同一套 service：

| 工具 | 干什么 |
| --- | --- |
| `catti_bank` | 查题库、改题、放行/拒绝/转人工 |
| `catti_import` | 解析文本、入库候选、导语料库 |
| `catti_paper` | 看模板余量、组卷预览、建卷、读卷 |
| `catti_exam` | 开始/暂停/继续/交卷、查剩余时间 |
| `catti_grade` | 待判列表、评分材料、写回；也能一键批改（start/status） |
| `catti_report` | 读成绩单、导出 Markdown |

---

## 安装

### 1. 放进 profile

在 DSH profile 目录（例如 `~/.dsh/profiles/desktop`）里把它加成一个依赖：

```bash
cd ~/.dsh/profiles/desktop
npm install --save "dsh-nihongo-test@file:/绝对路径/dsh-nihongo-test"
```

或者手工改 `package.json`（开发时用链接最方便）：

```json
{
  "dependencies": {
    "dsh-nihongo-test": "link:/绝对路径/dsh-nihongo-test"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-nihongo-test"]
    }
  }
}
```

`dependencies` 里加进去，`dsh.profile.bundles` 里也加一行，重启 DSH 才会挂上。

### 2. 配数据目录（可选）

包内的 `cordis.patch.yml` 只插一行、不写死路径，默认数据落在当前工作区的 `.dsh-nihongo-test`。要换位置就在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-nihongo-test
  config:
    dataDir: '/绝对路径/题库目录'
    corpusPath: '/绝对路径/translation-drill/data/corpus/items.json'   # 可选，导入语料库用
```

### 3. 重启

改完 `package.json` 的 bundles 或 `cordis.patch.yml` 都要重启 DSH。只改插件代码不用重启（Host 侧改动重载插件即可，Client 侧改动会热更新）。

---

## 数据目录

```
<dataDir>/
  banks/
    vocab.json  grammar.json  reading.json  ja2zh.json  zh2ja.json
  papers/        # 试卷（含题目快照）
  reports/       # 成绩单
  runtime/
    exams.json   # 进行中的考试（倒计时、答案）
  wrong.json     # 错题库
  exports/       # 导出的 Markdown
  audit_log.jsonl
```

全是明文 JSON，可以用任意编辑器改；插件会按文件 mtime 自动重读，不用重启。

各库条目形状：

```jsonc
// 客观题（vocab / grammar）
{ "id": "V-0001", "type": "vocab", "stem": "…", "options": ["…","…","…","…"],
  "answer": "B", "explanation": "…", "point": "「〜に伴い」接续", "difficulty": "L3",
  "source": "2014 二笔真题（解析版）", "exam_kind": "real", "year": 2014, "level": "2",
  "tags": ["真题"], "status": "active" }

// 阅读（一篇一条，内部带小题）
{ "id": "R-0001", "type": "reading", "passage": "…", "questions": [
    { "stem": "…", "options": ["…"], "answer": "A", "explanation": "…" } ] }

// 实务段（整篇 + 参考译文）
{ "id": "JC-0001", "type": "ja2zh", "text": "…", "ref": "…", "ref_src": "official",
  "chars": 656, "full_text": true, "rubric": ["…"] }
```

---

## 已知问题

- **一键批改需要宿主有 `llm` 服务**；没有就退回会话内的 `catti_grade material / commit` 路径。
- 默认模型档位若是 `reasoningEffort: max`，批改会拿不到文本（token 全花在推理上）。插件里已强制 `low`。
- 阅读理解一节按「篇」抽，篇内小题数不固定，所以实际题数可能略多于模板的 25 题（例如 27 题），分值按题均分。
- 实务只收整篇，不许把不相干的短段拼成一段，所以字数会超模板预算，只警告不拦。
- 阅读按整篇进错题库，一篇里错一题整篇都算错题。
- 真题判定按来源字样推断（「真题 / 模拟 / 教材」），导入时最好自己把 `exam_kind`、`year`、`level` 写清楚。

---

## 开发

```bash
# 语法/模块检查（不需要装依赖，Node 直接跑）
node test/check-modules.cjs .   # 若仓库里没有这个脚本，用下面的 smoke

# 冒烟测试：在临时目录上跑一遍完整链路
node test/smoke.cjs . /临时数据目录 /输出路径
```

`test/smoke.cjs` 覆盖：导入 → 放行 → 组卷 → 考试 → 交卷 → 客观判分 → 双评/三评写回 → 到点自动交卷 → 断点恢复 → 手改题库生效 → 缺答案转人工。

---

## 许可

MIT
