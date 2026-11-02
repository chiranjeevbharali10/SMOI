// Query load test: many users asking questions at once (POST /api/query, or /api/search with
// ENDPOINT=search). Run through loadtest/run.py, which starts the stack with the stub LLM so the
// test measures SMOI, not the model.
//
// Each virtual user (VU) logs in as one of USERS test users, set up once in setup(): each user
// uploads the same small set of documents, so every query searches realistic text.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://backend:8080';
const USERS = parseInt(__ENV.USERS || '10');
const ENDPOINT = __ENV.ENDPOINT || 'query';
const MODE = __ENV.MODE || 'hybrid';
// UNIQUE=1 makes every question different (a random suffix), so no cache can help.
const UNIQUE = __ENV.UNIQUE === '1';
const STAGES = JSON.parse(__ENV.STAGES || '[{"duration":"30s","target":5},{"duration":"30s","target":10},{"duration":"30s","target":20},{"duration":"30s","target":40}]');

const serverTotal = new Trend('smoi_server_total_ms', true);
const outcomes = new Counter('smoi_outcomes');

export const options = {
  setupTimeout: '10m',
  scenarios: { load: { executor: 'ramping-vus', startVUs: 1, stages: STAGES, gracefulRampDown: '10s' } },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const QUESTIONS = [
  'Which toad is the only toad native to Ireland?',
  'How long do natterjack toads live?',
  'How far can an agile frog jump?',
  'How many eggs are in an agile frog spawn clump?',
  'What was PostgreSQL originally called?',
  'What is a checkpoint in write-ahead logging?',
  'Which isolation level is most common with MVCC?',
  'Who designed SQLite?',
];
const DOCS = [
  ['natterjack_toad.txt', open('/corpus/frogs/natterjack_toad.txt', 'b')],
  ['agile_frog.docx', open('/corpus/frogs/agile_frog.docx', 'b')],
  ['write_ahead_logging.txt', open('/corpus/databases/write_ahead_logging.txt', 'b')],
  ['mvcc.pdf', open('/corpus/databases/mvcc.pdf', 'b')],
];

export function setup() {
  const tokens = [];
  for (let u = 0; u < USERS; u++) {
    const email = `load-${Date.now()}-${u}@example.com`;
    const password = 'load-test-password-1';
    http.post(`${BASE}/api/auth/register`, JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json' } });
    const token = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json' } }).json('accessToken');
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const ids = DOCS.map(([name, bytes]) =>
      http.post(`${BASE}/api/documents`, { file: http.file(bytes, name) }, auth).json('id'));
    for (const id of ids) {
      for (let i = 0; i < 300; i++) {
        if (http.get(`${BASE}/api/documents/${id}`, auth).json('status') === 'indexed') break;
        sleep(1);
      }
    }
    tokens.push(token);
  }
  return { tokens };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  const base = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const question = UNIQUE ? `${base} (case ${__VU}-${__ITER}-${Math.floor(Math.random() * 1e9)})` : base;
  const params = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                   tags: { endpoint: ENDPOINT }, timeout: '120s' };
  const res = ENDPOINT === 'search'
    ? http.post(`${BASE}/api/search`, JSON.stringify({ query: question, mode: MODE, topK: 10 }), params)
    : http.post(`${BASE}/api/query`, JSON.stringify({ question, mode: MODE }), params);
  check(res, { 'status 200': (r) => r.status === 200 });
  if (res.status === 200) {
    const body = res.json();
    if (body.timings) serverTotal.add(body.timings.totalMs);
    outcomes.add(1, { outcome: body.outcome || 'search' });
  }
}

export function handleSummary(data) {
  return { [`/results/${__ENV.RESULT_NAME || 'query'}.json`]: JSON.stringify(data, null, 2) };
}
