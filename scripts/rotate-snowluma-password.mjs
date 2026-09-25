import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    current: { type: 'string' },
    next: { type: 'string' },
    totp: { type: 'string' }
  }
});

const baseUrl = String(values.url || '').replace(/\/+$/, '');
// 密码优先走环境变量：命令行参数会出现在 /proc/<pid>/cmdline，对本机所有用户可读。
const current = String(values.current || process.env.QQ_AGENT_SNOWLUMA_CURRENT_PASSWORD || '');
const next = String(values.next || process.env.QQ_AGENT_SNOWLUMA_PASSWORD || '');
if (!baseUrl) throw new Error('--url is required');
if (!current) throw new Error('--current or QQ_AGENT_SNOWLUMA_CURRENT_PASSWORD is required');
if (!next) throw new Error('--next or QQ_AGENT_SNOWLUMA_PASSWORD is required');

async function post(route, body, token = '') {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // The status below still provides an actionable failure.
  }
  return { response, result };
}

const login = await post('/api/login', {
  password: current,
  ...(values.totp ? { totp: values.totp } : {})
});
if (login.result?.needsTotp) {
  throw new Error('SnowLuma has 2FA enabled; rerun with --snowluma-totp');
}
if (!login.response.ok || login.result?.success !== true || !login.result?.token) {
  throw new Error(login.result?.message || `SnowLuma login failed with HTTP ${login.response.status}`);
}

const changed = await post('/api/auth/change-password', {
  oldPassword: current,
  newPassword: next
}, login.result.token);
if (!changed.response.ok || changed.result?.success !== true) {
  throw new Error(changed.result?.message || `SnowLuma password change failed with HTTP ${changed.response.status}`);
}

console.log(JSON.stringify({ changed: true }));
