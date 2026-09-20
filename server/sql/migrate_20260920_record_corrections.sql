-- =============================================================================
-- 迁移: 生产记录纠错审批 + 不可变修订版本 + 审计历史
-- 兼容 MySQL 5.7 (不使用 8.0 的 ADD COLUMN IF NOT EXISTS / CHECK / JSON_TABLE)
-- 执行方式 (任选其一):
--   mysql -u root -p < server/sql/migrate_20260920_record_corrections.sql
--   USE production_tracking; SOURCE /path/to/migrate_20260920_record_corrections.sql;
-- 说明: 本脚本为一次性前向迁移，重复执行会因列/表已存在而报错（属正常）。
--       全新部署请直接使用 init.sql（已包含本迁移全部内容）。
-- =============================================================================

USE production_tracking;

-- -----------------------------------------------------------------------------
-- 1. production_records 增加版本追踪列
--    current_version : 当前生效版本号，0 = 原始上报未修订
--    last_revised_at : 最近一次被批准修订的时间
-- -----------------------------------------------------------------------------
ALTER TABLE production_records
  ADD COLUMN current_version INT NOT NULL DEFAULT 0 COMMENT '当前生效版本号：0=原始上报，每次批准纠错+1' AFTER created_at,
  ADD COLUMN last_revised_at DATETIME DEFAULT NULL COMMENT '最近修订生效时间' AFTER current_version;

-- -----------------------------------------------------------------------------
-- 2. 纠错申请表 record_corrections
--    status: 0=待审批 1=已批准 2=已驳回
--    pending_flag 为 5.7 虚拟生成列 + 唯一索引，数据库层面保证
--    “同一条生产记录最多只能有一条待审批申请”，防止重复申请。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_corrections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  record_id INT NOT NULL COMMENT '被纠错的生产记录ID',
  applicant_id INT NOT NULL COMMENT '申请人ID（必须为记录上报人本人）',

  original_completed_qty INT NOT NULL COMMENT '申请时快照：原完成数',
  original_defect_qty INT NOT NULL COMMENT '申请时快照：原不良数',
  original_work_hours DECIMAL(10,2) NOT NULL COMMENT '申请时快照：原工时',
  original_defect_reason VARCHAR(500) DEFAULT NULL COMMENT '申请时快照：原不良原因',
  original_remark VARCHAR(500) DEFAULT NULL COMMENT '申请时快照：原备注',

  corrected_completed_qty INT NOT NULL COMMENT '修正后完成数',
  corrected_defect_qty INT NOT NULL COMMENT '修正后不良数',
  corrected_work_hours DECIMAL(10,2) NOT NULL COMMENT '修正后工时',
  corrected_defect_reason VARCHAR(500) DEFAULT NULL COMMENT '修正后不良原因',
  corrected_remark VARCHAR(500) DEFAULT NULL COMMENT '修正后备注',

  reason VARCHAR(500) NOT NULL COMMENT '纠错原因（必填）',
  status TINYINT NOT NULL DEFAULT 0 COMMENT '0:待审批 1:已批准 2:已驳回',
  reviewer_id INT DEFAULT NULL COMMENT '审批主管ID',
  review_comment VARCHAR(500) DEFAULT NULL COMMENT '审批意见（驳回必填）',
  reviewed_at DATETIME DEFAULT NULL COMMENT '审批时间',

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  pending_flag TINYINT GENERATED ALWAYS AS (CASE WHEN status = 0 THEN 1 ELSE NULL END) VIRTUAL
    COMMENT '虚拟列：仅待审批行为1，配合唯一索引防重复待审批申请',

  UNIQUE KEY uq_record_pending (record_id, pending_flag),
  KEY idx_correction_status (status),
  KEY idx_correction_applicant (applicant_id),
  KEY idx_correction_record (record_id),

  CONSTRAINT fk_corr_record FOREIGN KEY (record_id)
    REFERENCES production_records(id) ON DELETE CASCADE,
  CONSTRAINT fk_corr_applicant FOREIGN KEY (applicant_id)
    REFERENCES users(id),
  CONSTRAINT fk_corr_reviewer FOREIGN KEY (reviewer_id)
    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产记录纠错申请表';

-- -----------------------------------------------------------------------------
-- 3. 不可变修订版本表 record_revisions
--    每次批准生成一行，保存记录与工单前后快照；
--    触发器禁止任何 UPDATE / DELETE（见文末），构成完整审计历史。
--    外键使用 RESTRICT：一旦某条记录产生过修订，记录与其申请均不可删除。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_revisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  record_id INT NOT NULL COMMENT '被修订的生产记录ID',
  correction_id INT NOT NULL COMMENT '来源纠错申请ID',
  version_no INT NOT NULL COMMENT '修订后版本号（从1开始）',

  old_completed_qty INT NOT NULL COMMENT '修订前完成数',
  new_completed_qty INT NOT NULL COMMENT '修订后完成数',
  old_defect_qty INT NOT NULL COMMENT '修订前不良数',
  new_defect_qty INT NOT NULL COMMENT '修订后不良数',
  old_work_hours DECIMAL(10,2) NOT NULL COMMENT '修订前工时',
  new_work_hours DECIMAL(10,2) NOT NULL COMMENT '修订后工时',
  old_defect_reason VARCHAR(500) DEFAULT NULL COMMENT '修订前不良原因',
  new_defect_reason VARCHAR(500) DEFAULT NULL COMMENT '修订后不良原因',
  old_remark VARCHAR(500) DEFAULT NULL COMMENT '修订前备注',
  new_remark VARCHAR(500) DEFAULT NULL COMMENT '修订后备注',

  old_order_completed_qty INT NOT NULL COMMENT '修订前工单累计完成数',
  new_order_completed_qty INT NOT NULL COMMENT '重算后工单累计完成数',
  old_order_defect_qty INT NOT NULL COMMENT '修订前工单累计不良数',
  new_order_defect_qty INT NOT NULL COMMENT '重算后工单累计不良数',
  old_order_work_hours DECIMAL(12,2) NOT NULL COMMENT '修订前工单累计工时',
  new_order_work_hours DECIMAL(12,2) NOT NULL COMMENT '重算后工单累计工时',
  old_order_status TINYINT NOT NULL COMMENT '修订前工单状态',
  new_order_status TINYINT NOT NULL COMMENT '重算后工单状态',

  approved_by INT NOT NULL COMMENT '批准人ID',
  approved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '批准生效时间',

  UNIQUE KEY uq_record_version (record_id, version_no),
  KEY idx_revision_correction (correction_id),

  CONSTRAINT fk_rev_record FOREIGN KEY (record_id)
    REFERENCES production_records(id),
  CONSTRAINT fk_rev_correction FOREIGN KEY (correction_id)
    REFERENCES record_corrections(id),
  CONSTRAINT fk_rev_approver FOREIGN KEY (approved_by)
    REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产记录不可变修订版本表（审计历史）';

-- -----------------------------------------------------------------------------
-- 4. 触发器：审计保护
--    a) production_records 仅允许通过审批流程修改“数值/文本字段”，
--       标识与归属字段(id/order_id/user_id/created_at)禁止篡改；
--    b) record_revisions 一经写入禁止 UPDATE / DELETE。
--    (mysql 命令行需要 DELIMITER；通过 MySQL 协议多语句执行时同样兼容)
-- -----------------------------------------------------------------------------
DELIMITER $$

DROP TRIGGER IF EXISTS trg_records_block_identity_update $$
CREATE TRIGGER trg_records_block_identity_update
BEFORE UPDATE ON production_records
FOR EACH ROW
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.order_id <> OLD.order_id
     OR NEW.user_id <> OLD.user_id
     OR IFNULL(NEW.created_at, '1970-01-01 00:00:00') <> IFNULL(OLD.created_at, '1970-01-01 00:00:00') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '生产记录标识/归属字段不可修改，数值纠错必须走纠错审批流程';
  END IF;
END $$

DROP TRIGGER IF EXISTS trg_revisions_block_update $$
CREATE TRIGGER trg_revisions_block_update
BEFORE UPDATE ON record_revisions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = '修订版本为不可变审计记录，禁止更新';
END $$

DROP TRIGGER IF EXISTS trg_revisions_block_delete $$
CREATE TRIGGER trg_revisions_block_delete
BEFORE DELETE ON record_revisions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = '修订版本为不可变审计记录，禁止删除';
END $$

DELIMITER ;
