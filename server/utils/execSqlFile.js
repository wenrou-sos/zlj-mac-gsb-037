const fs = require('fs');

/**
 * 将 SQL 文件内容切分为单条语句。
 * 支持 mysql CLI 的 DELIMITER 指令（用于触发器/存储过程），
 * 使 .sql 文件既可用 mysql 命令行执行，也可用本函数逐条执行。
 */
function splitSqlStatements(sql) {
  const statements = [];
  let delimiter = ';';
  let buffer = '';

  const lines = sql.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const dm = line.match(/^DELIMITER\s+(\S+)\s*$/i);
    if (dm) {
      delimiter = dm[1];
      continue;
    }
    buffer += rawLine + '\n';
    if (line.endsWith(delimiter)) {
      let stmt = buffer.trim();
      stmt = stmt.slice(0, stmt.length - delimiter.length).trim();
      if (stmt) statements.push(stmt);
      buffer = '';
    }
  }
  const tail = buffer.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * 逐条执行 .sql 文件（每条单独 query，不依赖 multipleStatements）。
 * @param {import('mysql2/promise').Connection} connection 已建立的连接
 * @param {string} filePath SQL 文件绝对路径
 */
async function execSqlFile(connection, filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const statements = splitSqlStatements(sql);
  for (const stmt of statements) {
    await connection.query(stmt);
  }
}

module.exports = { splitSqlStatements, execSqlFile };
