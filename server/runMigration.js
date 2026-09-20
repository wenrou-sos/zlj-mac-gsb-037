/**
 * 迁移执行器：无需 mysql 命令行，使用项目自身的 mysql2 连接执行 sql/ 下的迁移脚本。
 * 用法: node runMigration.js <迁移文件名>
 *   例: node runMigration.js migrate_20260920_record_corrections.sql
 *
 * 兼容两类语句：
 *   1) 普通 SQL（USE / ALTER / CREATE TABLE ...），按 ';' 切分，多语句批量发送；
 *   2) DELIMITER $$ ... $$ 包裹的触发器/存储过程，整块作为单条语句发送。
 * 字符串/行注释中的分隔符不会被误切。
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

function splitSql(raw) {
  const statements = [];
  const lines = raw.split(/\r?\n/);
  let delimiter = ';';
  let block = ''; // 当前分隔符模式下累积的内容

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.match(/^DELIMITER\s+/i)) {
      // 切换分隔符前，先冲刷默认 ';' 模式下累积的普通语句
      if (delimiter === ';' && block.trim()) {
        statements.push({ sql: block.trim(), multi: true });
        block = '';
      }
      delimiter = trimmed.replace(/^DELIMITER\s+/i, '').trim();
      continue;
    }

    if (delimiter !== ';') {
      // 自定义分隔符模式（如 $$）：整块收集，遇到以分隔符结尾的行结束
      if (trimmed.endsWith(delimiter)) {
        const stmtLine = line.slice(0, line.length - delimiter.length);
        block += stmtLine + '\n';
        const sql = block.trim();
        if (sql) statements.push({ sql, multi: false });
        block = '';
      } else {
        block += line + '\n';
      }
    } else {
      block += line + '\n';
    }
  }

  // 尾部普通语句
  if (delimiter === ';' && block.trim()) {
    statements.push({ sql: block.trim(), multi: true });
  }
  return statements;
}

/** 去掉 -- 整行注释与空行后是否仍有实际 SQL */
function isMeaningful(sql) {
  return sql.split(/\r?\n/)
    .map(l => l.trim())
    .some(l => l && !l.startsWith('--'));
}

async function run() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node runMigration.js <迁移文件名，如 migrate_20260920_record_corrections.sql>');
    process.exit(1);
  }
  const sqlPath = path.join(__dirname, 'sql', path.basename(file));
  if (!fs.existsSync(sqlPath)) {
    console.error(`❌ 迁移文件不存在: ${sqlPath}`);
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });

  try {
    const raw = fs.readFileSync(sqlPath, 'utf8');
    const statements = splitSql(raw).filter(s => isMeaningful(s.sql));
    console.log(`开始执行迁移: ${path.basename(file)}（共 ${statements.length} 组语句）`);
    for (const { sql, multi } of statements) {
      const preview = sql.replace(/\s+/g, ' ').slice(0, 80);
      console.log('  ▶', preview);
      await conn.query(sql);
    }
    console.log('✅ 迁移执行完成');
  } catch (err) {
    console.error('❌ 迁移失败:', err.message);
    console.error('提示: 迁移脚本为一次性前向迁移，若部分对象已存在请不要重复执行。');
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  run();
}

module.exports = { splitSql };
