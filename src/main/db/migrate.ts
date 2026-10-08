/**
 * 版本化迁移。
 *
 * 用 PRAGMA user_version 记录版本号，每次启动按序执行未跑过的迁移。
 * 迁移**只增不改**：已发布的迁移不可修改，否则已升级的库会错位。
 */
import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init_core',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          root_dir     TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          target_words INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS volumes (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title      TEXT NOT NULL,
          ord        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_volumes_project ON volumes(project_id, ord);

        CREATE TABLE IF NOT EXISTS chapters (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title      TEXT NOT NULL DEFAULT '',
          volume_id  TEXT REFERENCES volumes(id) ON DELETE SET NULL,
          ord        INTEGER NOT NULL,
          status     TEXT NOT NULL DEFAULT 'todo',
          char_count INTEGER NOT NULL DEFAULT 0,
          rev        INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id, ord);

        -- 正文单独存表，与元信息分表：列表只读元信息不拉正文（架构 §1.9 分页）
        CREATE TABLE IF NOT EXISTS chapter_bodies (
          chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
          body       TEXT NOT NULL DEFAULT ''
        );
      `);
    },
  },
  {
    version: 2,
    name: 'add_metrics_and_runs',
    up(db) {
      db.exec(`
        -- 逐章指标缓存（500 章仅 0.25MB，可全量缓存）
        CREATE TABLE IF NOT EXISTS chapter_metrics (
          chapter_id      TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
          chars           INTEGER NOT NULL,
          paras           INTEGER NOT NULL,
          sents           INTEGER NOT NULL,
          avg_sent        REAL NOT NULL,
          sent_cv         REAL NOT NULL,
          avg_para        REAL NOT NULL,
          sents_per_para  REAL NOT NULL,
          ttr             REAL NOT NULL,
          bigram_ttr      REAL NOT NULL,
          tri_repeat      REAL NOT NULL,
          dialog_ratio    REAL NOT NULL,
          score           REAL NOT NULL,
          computed_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_score ON chapter_metrics(score);

        CREATE TABLE IF NOT EXISTS style_profiles (
          project_id      TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          source          TEXT NOT NULL,
          sample_chapters INTEGER NOT NULL,
          metrics_json    TEXT NOT NULL,
          marker_json     TEXT NOT NULL,
          updated_at      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          id           TEXT PRIMARY KEY,
          project_id   TEXT NOT NULL,
          goal         TEXT NOT NULL,
          status       TEXT NOT NULL,
          termination  TEXT,
          stats_json   TEXT,
          kept_changes INTEGER NOT NULL DEFAULT 0,
          started_at   INTEGER NOT NULL,
          ended_at     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS observations (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          step_no    INTEGER NOT NULL,
          tool_name  TEXT NOT NULL,
          kind       TEXT NOT NULL,
          summary    TEXT NOT NULL,
          data_json  TEXT,
          ok         INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_obs_run ON observations(run_id, step_no);
      `);
    },
  },
  {
    version: 3,
    name: 'add_ledger',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ledger_characters (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name       TEXT NOT NULL,
          payload    TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_char_project ON ledger_characters(project_id);

        CREATE TABLE IF NOT EXISTS ledger_numbers (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          subject    TEXT NOT NULL,
          payload    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_num_project ON ledger_numbers(project_id, subject);

        CREATE TABLE IF NOT EXISTS ledger_timeline (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          "when"     TEXT NOT NULL,
          payload    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_tl_project ON ledger_timeline(project_id, "when");

        CREATE TABLE IF NOT EXISTS ledger_foreshadows (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status        TEXT NOT NULL,
          planted_chapter TEXT,
          payload       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_fs_project ON ledger_foreshadows(project_id, status);

        CREATE TABLE IF NOT EXISTS ledger_conflicts (
          id         TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          subject    TEXT NOT NULL,
          payload    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_cf_project ON ledger_conflicts(project_id, kind);
      `);
    },
  },
  {
    version: 4,
    name: 'add_checkpoints',
    up(db) {
      db.exec(`
        -- checkpoint 索引（正文在磁盘存档里，库里只存元信息）
        CREATE TABLE IF NOT EXISTS checkpoints (
          id            TEXT PRIMARY KEY,
          run_id        TEXT NOT NULL,
          seq           INTEGER NOT NULL,
          step_no       INTEGER NOT NULL,
          tool_name     TEXT NOT NULL,
          at            INTEGER NOT NULL,
          bytes         INTEGER NOT NULL,
          tier          TEXT NOT NULL,
          archive_file  TEXT,
          rolled_back_at INTEGER,
          edits_count   INTEGER NOT NULL DEFAULT 0,
          chapters_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ckpt_run ON checkpoints(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_ckpt_seq ON checkpoints(seq);
      `);
    },
  },
  {
    version: 5,
    name: 'add_expert_team',
    up(db) {
      db.exec(`
        -- 专家团调用记录：每次评审一条
        CREATE TABLE IF NOT EXISTS expert_reviews (
          id           TEXT PRIMARY KEY,
          project_id   TEXT NOT NULL,
          stage        TEXT NOT NULL,        -- outline | chapter | post-polish
          target_ids   TEXT NOT NULL,        -- JSON 数组
          roles        TEXT NOT NULL,        -- JSON 数组：实际激活的角色
          verdicts     TEXT NOT NULL,        -- JSON：裁决结果
          summary      TEXT NOT NULL,        -- JSON：汇总统计
          provider_id  TEXT,
          model        TEXT,
          tokens_in    INTEGER NOT NULL DEFAULT 0,
          tokens_out   INTEGER NOT NULL DEFAULT 0,
          cost_cny     REAL NOT NULL DEFAULT 0,   -- 本地模型恒为 0
          duration_ms  INTEGER NOT NULL DEFAULT 0,
          status       TEXT NOT NULL,        -- ok | partial | failed | aborted
          error        TEXT,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_expert_reviews_project
          ON expert_reviews(project_id, created_at DESC);

        -- 单条专家意见：便于回答「哪个专家最常提哪类问题」「什么意见最终被采纳」
        -- 拆成两张表就是为了让意见可独立聚合分析，而不只能整份读取
        CREATE TABLE IF NOT EXISTS expert_opinions (
          id             TEXT PRIMARY KEY,
          review_id      TEXT NOT NULL REFERENCES expert_reviews(id) ON DELETE CASCADE,
          role           TEXT NOT NULL,
          dimension      TEXT NOT NULL,
          severity       TEXT NOT NULL,
          verdict        TEXT NOT NULL,
          weight         REAL NOT NULL,      -- 当时的生效权重（历史留痕）
          cross_boundary INTEGER NOT NULL,  -- 1 = 越界，被降权过
          adopted        INTEGER,            -- 裁决后是否被采纳（NULL = 待作者裁决）
          evidence       TEXT,
          suggestion     TEXT,
          raw            TEXT                -- 模型原始返回，便于回溯
        );
        CREATE INDEX IF NOT EXISTS idx_expert_opinions_review
          ON expert_opinions(review_id);
        CREATE INDEX IF NOT EXISTS idx_expert_opinions_dim
          ON expert_opinions(dimension, severity);
      `);
    },
  },
  {
    version: 6,
    name: 'add_ai_flavor',
    up(db) {
      db.exec(`
        -- ★ AI 味检测是独立板块：自有表、自有配置、与专家团零耦合。
        --   不塞进 expert_reviews 是为了让两个功能各自演进——
        --   删除 AI 味板块时不必碰专家团的表。

        -- 每次检测一条
        CREATE TABLE IF NOT EXISTS flavor_scans (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          chapter_id    TEXT NOT NULL,
          index_score   INTEGER NOT NULL,     -- 总 AI 味指数 0~100
          level         TEXT NOT NULL,        -- clean|mild|suspicious|heavy|severe
          chars         INTEGER NOT NULL,
          paragraphs    INTEGER NOT NULL,
          hit_count     INTEGER NOT NULL,
          dominant_dim  TEXT,                 -- 主导维度
          sufficient    INTEGER NOT NULL,     -- 0=样本不足，指数不可信
          engine_version TEXT NOT NULL,       -- 口径版本，前后对比时判断是否可比
          dimensions    TEXT NOT NULL,        -- JSON：各维度得分
          report        TEXT NOT NULL,        -- JSON：完整报告（含命中定位）
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_flavor_scans_chapter
          ON flavor_scans(project_id, chapter_id, created_at DESC);

        -- 改写记录：支持「改写前后 AI 味分值对比」这一硬需求
        CREATE TABLE IF NOT EXISTS flavor_rewrites (
          id            TEXT PRIMARY KEY,
          project_id    TEXT NOT NULL,
          chapter_id    TEXT NOT NULL,
          scan_id       TEXT,                 -- 改写前的检测记录
          path          TEXT NOT NULL,        -- auto-rule | agent
          run_id        TEXT,                 -- agent 路径时关联的 run
          changed_count INTEGER NOT NULL,
          before_index  INTEGER NOT NULL,
          after_index   INTEGER NOT NULL,
          delta         INTEGER NOT NULL,     -- 正数=改善
          regressed_dims TEXT,                -- JSON：变差的维度（如实记录）
          edits         TEXT,                 -- JSON：逐处改动
          message       TEXT,
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_flavor_rewrites_chapter
          ON flavor_rewrites(project_id, chapter_id, created_at DESC);

        -- 板块配置（独立于专家团配置）
        CREATE TABLE IF NOT EXISTS flavor_config (
          project_id  TEXT PRIMARY KEY,
          config      TEXT NOT NULL,          -- JSON
          updated_at  INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    name: 'add_flavor_baselines',
    up(db) {
      db.exec(`
        -- ★ 基线是 AI 味板块的独立资产：内置默认基线是常量（DEFAULT_FLAVOR_BASELINE），
        --   本表只存**用户用自己的语料算出的**基线（source='user'）。
        --   仍保留 source 列以便将来允许「把内置基线固化进库」而不改表结构。
        --   删掉 AI 味板块时不必碰专家团与其余业务表。
        CREATE TABLE IF NOT EXISTS flavor_baselines (
          id             TEXT PRIMARY KEY,
          project_id     TEXT NOT NULL,
          corpus         TEXT NOT NULL,
          chapters       INTEGER NOT NULL,
          total_chars    INTEGER NOT NULL,
          engine_version TEXT NOT NULL,
          source         TEXT NOT NULL,        -- builtin | user
          data           TEXT NOT NULL,        -- JSON：完整 FlavorBaseline
          created_at     INTEGER NOT NULL
        );
        -- 取「该项目最新一条」（DESC）是最高频查询，故按 (project_id, created_at DESC) 建索引
        CREATE INDEX IF NOT EXISTS idx_flavor_baselines_project
          ON flavor_baselines(project_id, created_at DESC);
      `);
    },
  },
  {
    version: 8,
    name: 'add_daily_writes',
    up(db) {
      db.exec(`
        -- ★ 日增量账（§4 第 3 条）：每章只有一个 updated_at 瞬时戳，改一次覆盖一次，
        --   所以"今天写了多少字 / 连更几天"在修复前的数据结构里根本问不出来。
        --   按 (项目, 本地日) 存**净增**（新字数 − 旧字数，可为负），同一天累加。
        --   主键 (project_id, day) 就是最高频查询的形状（"这个项目最近 N 天"），
        --   不再另建索引——重复索引只会让每次保存多写一棵 B 树。
        CREATE TABLE IF NOT EXISTS daily_writes (
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          day         TEXT NOT NULL,           -- 本地日期 YYYY-MM-DD，零填充，可按字符串比大小
          delta_chars INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_id, day)
        );

        -- 千字单价（元）。默认 0 = 用户还没填，仪表盘据此显示「未设单价」而不是猜一个。
        ALTER TABLE projects ADD COLUMN price_per_k INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
];

export function migrate(db: Database): void {
  const row = db.pragma('user_version', { simple: true }) as number;
  let current = typeof row === 'number' ? row : 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // 每个迁移一个事务：失败不会留下半迁移状态
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    current = m.version;
  }
}

export function currentVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}