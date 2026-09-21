#!/usr/bin/env node
// 生成可分享的干净副本 + 敏感串扫描。
//
// 只复制 git 已跟踪的文件（data/、config.json、.console-tunnel.cfg、_staging 等
// 天然不会进入副本），然后在副本里扫描常见的敏感残留：
//   - 长十六进制串（控制台令牌形态）、"Token:" 开头的行
//   - sk- / ghp_ 之类的密钥前缀
//   - 非私网、非文档示例的公网 IPv4
//   - 非 noreply 的邮箱地址
//
// 用法：
//   node scripts/sanitize-release.mjs                 # 输出到 ../qq-agent-clean
//   node scripts/sanitize-release.mjs --out=/tmp/x    # 指定输出目录
//   node scripts/sanitize-release.mjs --force         # 输出目录已存在时覆盖
// 退出码：0 = 副本已生成且扫描干净；1 = 有发现或参数/环境有问题。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = path.resolve(outArg ? outArg.slice('--out='.length) : path.join(ROOT, '..', 'qq-agent-clean'));
const FORCE = args.includes('--force');

const PRIVATE_IPV4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|255\.)/;
const DOC_IPV4 = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;
const SAFE_EMAIL = /(@users\.noreply\.github\.com$|@example\.(com|org|net)$)/i;
// 图片/压缩包的魔数前缀、以及 aaaa…/0000… 这类低熵串不算令牌。
const BINARY_MAGIC = /^(89504e47|ffd8ff|47494638|504b0304)/i;
const LOW_ENTROPY = (value) => new Set(value.toLowerCase()).size <= 3;
// IPv4 只在「URL / ssh 目标 / 主带端口」的语境下算泄露迹象；
// 裸的 1.2.3.4 可能是版本号（例如微信 3.9.12.51），不报。
const IPV4_CONTEXT = /(?:\b(?:https?|ssh|git|ftp):\/\/|@)(\d{1,3}(?:\.\d{1,3}){3})\b|\b(\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/g;

// 通用示例不算泄露：文档里出现 /home/user、/home/ubuntu、C:\Users\user 这类占位是正常的。
const EXAMPLE_USER_PATH = /(?:\/(?:home|Users)\/(?:user|ubuntu|deploy|sourcecode|example|<[^>]+>)|[A-Za-z]:\\Users\\(?:user|public|Public|example|<[^>]+>))/i;

const SCANNERS = [
  { name: '长十六进制串（疑似令牌）', re: /\b[0-9a-f]{40,}\b/gi },
  { name: '本机真实用户目录', re: /(?:\/(?:home|Users)\/[A-Za-z0-9._-]{2,}|[A-Za-z]:\\Users\\[^\\\s"']{2,})/g , filter: (hit) => !EXAMPLE_USER_PATH.test(hit) },
  { name: 'Token: 行', re: /^\s*Token\s*[:=]\s*["']?[0-9a-f]{16,}["']?\s*$/gim },
  { name: 'API 密钥前缀', re: /\b(sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g },
  { name: '公网 IPv4', re: null },
  { name: '非 noreply 邮箱', re: null }
];

function listTrackedFiles() {
  const raw = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function copyTracked(files) {
  let copied = 0;
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    const dst = path.join(OUT, rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied += 1;
  }
  return copied;
}

function scanFile(rel, text) {
  const findings = [];
  for (const scanner of SCANNERS) {
    if (scanner.re) {
      const matches = text.match(scanner.re);
      if (matches) {
        for (const raw of new Set(matches.map((m) => m.trim()))) {
          if (BINARY_MAGIC.test(raw) || LOW_ENTROPY(raw)) continue;
          if (scanner.filter && !scanner.filter(raw)) continue;
          findings.push(`${rel}: ${scanner.name} -> ${raw.slice(0, 80)}`);
        }
      }
      continue;
    }
    if (scanner.name === '公网 IPv4') {
      for (const match of text.matchAll(IPV4_CONTEXT)) {
        const hit = match[1] || match[2] || '';
        if (!hit || PRIVATE_IPV4.test(hit) || DOC_IPV4.test(hit)) continue;
        findings.push(`${rel}: 公网 IPv4 -> ${hit}`);
      }
    }
    if (scanner.name === '非 noreply 邮箱') {
      for (const hit of new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])) {
        if (SAFE_EMAIL.test(hit)) continue;
        findings.push(`${rel}: 非 noreply 邮箱 -> ${hit}`);
      }
    }
  }
  return findings;
}

function main() {
  if (fs.existsSync(OUT)) {
    if (!FORCE) {
      console.error(`输出目录已存在：${OUT}\n（要覆盖请加 --force）`);
      return 1;
    }
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  const files = listTrackedFiles();
  const copied = copyTracked(files);
  console.log(`已复制 ${copied} 个受跟踪文件 -> ${OUT}`);

  const findings = [];
  for (const rel of files) {
    const file = path.join(OUT, rel);
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue; // 二进制跳过
    const text = buffer.toString('utf8');
    findings.push(...scanFile(rel, text));
  }

  if (findings.length) {
    console.error(`\n发现 ${findings.length} 处疑似敏感内容：`);
    for (const line of findings.slice(0, 100)) console.error(`  - ${line}`);
    // 命中就删副本：避免"有命中但仍被分享出去"
    try {
      fs.rmSync(OUT, { recursive: true, force: true });
      console.error('\n已删除本次生成的副本，请清理后重新生成。');
    } catch {
      console.error('\n请手动删除本次生成的副本（自动删除失败）。');
    }
    return 1;
  }
  console.log('扫描通过：未发现令牌 / 密钥 / 公网 IP / 真实邮箱 / 本机用户目录。');
  console.log('注意：这是粗筛，不保证覆盖所有敏感形态（域名、业务标识、截图内容等），外发前建议再人工过一遍。');
  console.log('（data/、config.json、console-access.txt 等本地文件本来就不在受跟踪文件里。）');
  return 0;
}

process.exit(main());
