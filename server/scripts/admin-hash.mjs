#!/usr/bin/env node
// 用法：node scripts/admin-hash.mjs '<password>'
// 输出 bcrypt hash —— 拷到 systemd EnvironmentFile 里 ADMIN_PASSWORD_HASH。
//
// 单引号包密码，避免 shell 解析 $ # ! 等特殊字符。

import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error("用法：node scripts/admin-hash.mjs '<password>'");
  process.exit(2);
}
const hash = await bcrypt.hash(password, 12);
console.log(hash);
