// Upload load test: users uploading documents at a steady rate. Each upload is unique text (so
// duplicate detection doesn't short-circuit it), about 1,500 words, which the backend splits into
// several chunks to embed. The test only measures the upload request itself; how fast the
// ingestion workers drain the queue is measured by loadtest/run.py from the document statuses and
// the queue gauges.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://backend:8080';
const RATE = parseInt(__ENV.RATE || '2');          // uploads per second
const DURATION = __ENV.DURATION || '60s';
const USERS = parseInt(__ENV.USERS || '5');

const uploaded = new Counter('smoi_uploaded');

export const options = {
  scenarios: {
    uploads: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION,
               preAllocatedVUs: 10, maxVUs: 50 },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const WORDS = ('frog toad pond spawn tadpole winter marsh pool database index tree page log commit '
  + 'snapshot planet moon ring orbit storm ocean ice volcano plume crater').split(' ');

export function setup() {
  const users = [];
  for (let u = 0; u < USERS; u++) {
    const email = `upload-${Date.now()}-${u}@example.com`;
    const password = 'load-test-password-1';
    const headers = { headers: { 'Content-Type': 'application/json' } };
    http.post(`${BASE}/api/auth/register`, JSON.stringify({ email, password }), headers);
    users.push(http.post(`${BASE}/api/auth/login`, JSON.stringify({ email, password }), headers).json('accessToken'));
  }
  return { users };
}

function document(id) {
  const paragraphs = [];
  for (let p = 0; p < 15; p++) {
    const words = [];
    for (let w = 0; w < 100; w++) words.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
    paragraphs.push(`Load document ${id} paragraph ${p}. ` + words.join(' ') + '.');
  }
  return paragraphs.join('\n\n');
}

export default function (data) {
  const token = data.users[Math.floor(Math.random() * data.users.length)];
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${BASE}/api/documents`, { file: http.file(document(id), `load-${id}.txt`, 'text/plain') },
    { headers: { Authorization: `Bearer ${token}` }, tags: { endpoint: 'upload' } });
  check(res, { 'accepted': (r) => r.status === 202 });
  if (res.status === 202) uploaded.add(1);
}

export function handleSummary(data) {
  return { [`/results/${__ENV.RESULT_NAME || 'upload'}.json`]: JSON.stringify(data, null, 2) };
}
