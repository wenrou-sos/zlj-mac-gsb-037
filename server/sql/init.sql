-- 创建数据库
CREATE DATABASE IF NOT EXISTS production_tracking DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE production_tracking;

-- 产线表
DROP TABLE IF EXISTS production_lines;
CREATE TABLE production_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  line_name VARCHAR(100) NOT NULL UNIQUE COMMENT '产线名称',
  line_code VARCHAR(50) NOT NULL UNIQUE COMMENT '产线编码',
  status TINYINT DEFAULT 1 COMMENT '1:启用 0:停用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='产线表';

-- 产品型号表
DROP TABLE IF EXISTS products;
CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_name VARCHAR(200) NOT NULL COMMENT '产品名称',
  product_model VARCHAR(100) NOT NULL UNIQUE COMMENT '产品型号',
  specification VARCHAR(500) COMMENT '规格说明',
  unit VARCHAR(20) DEFAULT '件' COMMENT '单位',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='产品型号表';

-- 用户表（主管、操作工）
DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE COMMENT '用户名',
  password VARCHAR(255) NOT NULL DEFAULT '123456' COMMENT '密码',
  real_name VARCHAR(50) NOT NULL COMMENT '真实姓名',
  role TINYINT NOT NULL COMMENT '1:车间主管 2:操作工',
  line_id INT DEFAULT NULL COMMENT '所属产线ID（操作工）',
  status TINYINT DEFAULT 1 COMMENT '1:正常 0:禁用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (line_id) REFERENCES production_lines(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- 工单表
DROP TABLE IF EXISTS work_orders;
CREATE TABLE work_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(50) NOT NULL UNIQUE COMMENT '工单编号',
  line_id INT NOT NULL COMMENT '产线ID',
  product_id INT NOT NULL COMMENT '产品ID',
  plan_qty INT NOT NULL COMMENT '计划数量',
  completed_qty INT DEFAULT 0 COMMENT '已完成数量',
  defect_qty INT DEFAULT 0 COMMENT '不良数量',
  total_work_hours DECIMAL(10,2) DEFAULT 0 COMMENT '累计工时(小时)',
  defect_threshold DECIMAL(5,2) DEFAULT 5.00 COMMENT '不良率告警阈值(%)，默认5%',
  status TINYINT DEFAULT 0 COMMENT '0:待生产 1:生产中 2:已完成 3:已暂停',
  assigned_by INT NOT NULL COMMENT '指派人工号',
  start_time DATETIME DEFAULT NULL COMMENT '实际开始时间',
  end_time DATETIME DEFAULT NULL COMMENT '实际结束时间',
  remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (line_id) REFERENCES production_lines(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工单表';

-- 生产进度记录表
-- current_version: 当前生效版本号 0=原始上报，每批准一次纠错 +1
DROP TABLE IF EXISTS record_revisions;
DROP TABLE IF EXISTS record_corrections;
DROP TABLE IF EXISTS production_records;
CREATE TABLE production_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL COMMENT '工单ID',
  user_id INT NOT NULL COMMENT '上报人ID',
  completed_qty INT NOT NULL DEFAULT 0 COMMENT '本次完成数量（当前生效值）',
  defect_qty INT NOT NULL DEFAULT 0 COMMENT '本次不良数量（当前生效值）',
  work_hours DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '本次工时(小时，当前生效值)',
  defect_reason VARCHAR(500) DEFAULT NULL COMMENT '不良原因（当前生效值）',
  remark VARCHAR(500) DEFAULT NULL COMMENT '备注（当前生效值）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_version INT NOT NULL DEFAULT 0 COMMENT '当前生效版本号：0=原始上报',
  last_revised_at DATETIME DEFAULT NULL COMMENT '最近修订生效时间',
  FOREIGN KEY (order_id) REFERENCES work_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产进度记录表';

-- 纠错申请表（status: 0待审批 1已批准 2已驳回）
-- pending_flag 虚拟列 + 唯一索引：同一记录最多一条待审批申请（MySQL 5.7 兼容写法）
CREATE TABLE record_corrections (
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

  pending_flag TINYINT GENERATED ALWAYS AS (CASE WHEN status = 0 THEN 1 ELSE NULL END) VIRTUAL,

  UNIQUE KEY uq_record_pending (record_id, pending_flag),
  KEY idx_correction_status (status),
  KEY idx_correction_applicant (applicant_id),
  KEY idx_correction_record (record_id),

  FOREIGN KEY (record_id) REFERENCES production_records(id) ON DELETE CASCADE,
  FOREIGN KEY (applicant_id) REFERENCES users(id),
  FOREIGN KEY (reviewer_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产记录纠错申请表';

-- 不可变修订版本表（每次批准一行；触发器禁止 UPDATE/DELETE；外键 RESTRICT 防删除）
CREATE TABLE record_revisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  record_id INT NOT NULL COMMENT '被修订的生产记录ID',
  correction_id INT NOT NULL COMMENT '来源纠错申请ID',
  version_no INT NOT NULL COMMENT '修订后版本号（从1开始）',

  old_completed_qty INT NOT NULL,
  new_completed_qty INT NOT NULL,
  old_defect_qty INT NOT NULL,
  new_defect_qty INT NOT NULL,
  old_work_hours DECIMAL(10,2) NOT NULL,
  new_work_hours DECIMAL(10,2) NOT NULL,
  old_defect_reason VARCHAR(500) DEFAULT NULL,
  new_defect_reason VARCHAR(500) DEFAULT NULL,
  old_remark VARCHAR(500) DEFAULT NULL,
  new_remark VARCHAR(500) DEFAULT NULL,

  old_order_completed_qty INT NOT NULL,
  new_order_completed_qty INT NOT NULL,
  old_order_defect_qty INT NOT NULL,
  new_order_defect_qty INT NOT NULL,
  old_order_work_hours DECIMAL(12,2) NOT NULL,
  new_order_work_hours DECIMAL(12,2) NOT NULL,
  old_order_status TINYINT NOT NULL,
  new_order_status TINYINT NOT NULL,

  approved_by INT NOT NULL,
  approved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_record_version (record_id, version_no),
  KEY idx_revision_correction (correction_id),

  FOREIGN KEY (record_id) REFERENCES production_records(id),
  FOREIGN KEY (correction_id) REFERENCES record_corrections(id),
  FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='生产记录不可变修订版本表（审计历史）';

-- 插入测试数据：产线
INSERT INTO production_lines (line_name, line_code, status) VALUES
('一号组装线', 'LINE-A01', 1),
('二号组装线', 'LINE-A02', 1),
('三号包装线', 'LINE-B01', 1),
('四号测试线', 'LINE-C01', 1),
('五号SMT线', 'LINE-D01', 1);

-- 插入测试数据：产品
INSERT INTO products (product_name, product_model, specification, unit) VALUES
('智能路由器', 'RT-X200', '双频千兆，4天线', '台'),
('无线蓝牙耳机', 'EB-S100', 'TWS真无线，降噪', '副'),
('智能手表', 'SW-P300', '心率监测，GPS定位', '只'),
('移动电源', 'PB-M500', '20000mAh，快充', '个'),
('USB-C数据线', 'CB-C200', '1米，快充65W', '条');

-- 插入测试数据：用户
INSERT INTO users (username, password, real_name, role, line_id, status) VALUES
('admin', '123456', '张主管', 1, NULL, 1),
('manager', '123456', '李经理', 1, NULL, 1),
('worker01', '123456', '王操作', 2, 1, 1),
('worker02', '123456', '赵操作', 2, 2, 1),
('worker03', '123456', '刘操作', 2, 3, 1),
('worker04', '123456', '陈操作', 2, 4, 1),
('worker05', '123456', '孙操作', 2, 5, 1);

-- 插入测试数据：工单
INSERT INTO work_orders (order_no, line_id, product_id, plan_qty, completed_qty, defect_qty, total_work_hours, defect_threshold, status, assigned_by, start_time, end_time, remark) VALUES
('WO20260614001', 1, 1, 500, 320, 12, 16.5, 5.00, 1, 1, '2026-06-14 08:00:00', NULL, '首批次生产'),
('WO20260614002', 2, 2, 1000, 680, 25, 14.0, 5.00, 1, 1, '2026-06-14 08:00:00', NULL, '加急订单'),
('WO20260614003', 3, 4, 2000, 2000, 18, 22.5, 5.00, 2, 1, '2026-06-13 08:00:00', '2026-06-14 12:00:00', '已完成'),
('WO20260614004', 4, 3, 300, 0, 0, 0, 5.00, 0, 2, NULL, NULL, '待投产'),
('WO20260614005', 5, 5, 5000, 1200, 45, 8.0, 5.00, 1, 2, '2026-06-14 08:30:00', NULL, '常规生产');

-- 插入测试数据：生产记录
INSERT INTO production_records (order_id, user_id, completed_qty, defect_qty, work_hours, defect_reason, remark) VALUES
(1, 3, 150, 5, 8.0, '外观划痕', '上午班'),
(1, 3, 170, 7, 8.5, '焊点不良', '下午班'),
(2, 4, 400, 15, 7.0, '配对失败', '上午班'),
(2, 4, 280, 10, 7.0, '充电异常', '下午班'),
(3, 5, 1000, 8, 11.0, '容量不足', '第一班'),
(3, 5, 1000, 10, 11.5, '外壳变形', '第二班'),
(5, 7, 600, 20, 4.0, '线皮破损', '上午班'),
(5, 7, 600, 25, 4.0, '接触不良', '下午班');

-- =============================================================================
-- 审计保护触发器（随 init:db 通过 MySQL 协议整体执行；
-- 命令行 SOURCE 方式请改用 migrate_20260920_record_corrections.sql 中的 DELIMITER 版本）
-- =============================================================================

-- 生产记录：禁止修改标识/归属字段，数值纠错只能走审批流程
DROP TRIGGER IF EXISTS trg_records_block_identity_update;
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
END;

-- 修订版本：写入后不可更新
DROP TRIGGER IF EXISTS trg_revisions_block_update;
CREATE TRIGGER trg_revisions_block_update
BEFORE UPDATE ON record_revisions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '修订版本为不可变审计记录，禁止更新';
END;

-- 修订版本：禁止删除
DROP TRIGGER IF EXISTS trg_revisions_block_delete;
CREATE TRIGGER trg_revisions_block_delete
BEFORE DELETE ON record_revisions
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '修订版本为不可变审计记录，禁止删除';
END;
