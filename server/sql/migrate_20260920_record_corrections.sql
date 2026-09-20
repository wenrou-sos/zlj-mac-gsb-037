-- ============================================================
-- 迁移脚本：生产记录纠错审批
-- 日期：2026-09-20
-- 兼容：MySQL 5.7+ / 8.0（使用生成列、触发器，均受 5.7 支持）
-- 说明：幂等，可重复执行
--   1. record_correction_requests  纠错申请表
--   2. record_revisions            修订版本表（只增不改，审计历史）
--   3. production_records          增加 current_revision_id 生效指针
--   4. 触发器                      禁止 UPDATE 修订版本表
-- ============================================================

USE production_tracking;

-- ------------------------------------------------------------
-- 1. 纠错申请表
--    pending_record_id 为生成列：仅当 status=0(待审批) 时取 record_id，
--    配合唯一索引，数据库层面保证同一记录最多存在一条待审批申请。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_correction_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(40) NOT NULL COMMENT '申请单号',
  record_id INT NOT NULL COMMENT '被纠错的生产记录ID',
  order_id INT NOT NULL COMMENT '关联工单ID（冗余，便于锁定与查询）',
  applicant_id INT NOT NULL COMMENT '申请人（操作工）ID',
  old_completed_qty INT NOT NULL COMMENT '申请时生效值快照：完成数',
  old_defect_qty INT NOT NULL COMMENT '申请时生效值快照：不良数',
  old_work_hours DECIMAL(10,2) NOT NULL COMMENT '申请时生效值快照：工时',
  old_defect_reason VARCHAR(500) DEFAULT NULL COMMENT '申请时生效值快照：不良原因',
  new_completed_qty INT NOT NULL COMMENT '修正值：完成数',
  new_defect_qty INT NOT NULL COMMENT '修正值：不良数',
  new_work_hours DECIMAL(10,2) NOT NULL COMMENT '修正值：工时',
  new_defect_reason VARCHAR(500) DEFAULT NULL COMMENT '修正值：不良原因',
  reason VARCHAR(500) NOT NULL COMMENT '纠错原因',
  status TINYINT NOT NULL DEFAULT 0 COMMENT '0:待审批 1:已批准 2:已驳回',
  reviewed_by INT DEFAULT NULL COMMENT '审批人ID',
  reviewed_at DATETIME DEFAULT NULL COMMENT '审批时间',
  review_comment VARCHAR(500) DEFAULT NULL COMMENT '审批意见',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  pending_record_id INT GENERATED ALWAYS AS (IF(status = 0, record_id, NULL)) STORED COMMENT '生成列：待审批时等于record_id，否则为NULL',
  UNIQUE KEY uk_request_no (request_no),
  UNIQUE KEY uk_pending_record (pending_record_id),
  KEY idx_record (record_id),
  KEY idx_order (order_id),
  KEY idx_applicant (applicant_id),
  KEY idx_status (status),
  FOREIGN KEY (record_id) REFERENCES production_records(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (applicant_id) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产记录纠错申请表';

-- ------------------------------------------------------------
-- 2. 修订版本表（审计历史，只增不改）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS record_revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  record_id INT NOT NULL COMMENT '生产记录ID',
  request_id INT NOT NULL COMMENT '来源纠错申请ID',
  revision_no INT NOT NULL COMMENT '修订版本号，每条记录从1开始递增',
  completed_qty INT NOT NULL COMMENT '本版本生效值：完成数',
  defect_qty INT NOT NULL COMMENT '本版本生效值：不良数',
  work_hours DECIMAL(10,2) NOT NULL COMMENT '本版本生效值：工时',
  defect_reason VARCHAR(500) DEFAULT NULL COMMENT '本版本生效值：不良原因',
  remark VARCHAR(500) DEFAULT NULL COMMENT '批准时原记录备注快照',
  changed_by INT NOT NULL COMMENT '生效操作人（审批主管）ID',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_record_revision (record_id, revision_no),
  UNIQUE KEY uk_request (request_id),
  FOREIGN KEY (record_id) REFERENCES production_records(id) ON DELETE CASCADE,
  FOREIGN KEY (request_id) REFERENCES record_correction_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产记录修订版本表（只增不改）';

-- ------------------------------------------------------------
-- 3. production_records 增加当前生效修订指针（幂等）
--    不加外键以避免与 record_revisions 形成循环依赖，
--    该指针由应用在事务内维护。
-- ------------------------------------------------------------
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'production_records'
    AND COLUMN_NAME = 'current_revision_id'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE production_records
     ADD COLUMN current_revision_id INT DEFAULT NULL COMMENT ''当前生效修订版本ID，NULL表示原始值生效'' AFTER remark,
     ADD KEY idx_current_revision (current_revision_id)',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------
-- 4. 修订版本表不可变：禁止 UPDATE
--    （不禁止 DELETE：工单/记录删除时需级联清理）
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_record_revisions_no_update;

DELIMITER //
CREATE TRIGGER trg_record_revisions_no_update
BEFORE UPDATE ON record_revisions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'record_revisions 为不可变审计表，禁止 UPDATE';
END//
DELIMITER ;
