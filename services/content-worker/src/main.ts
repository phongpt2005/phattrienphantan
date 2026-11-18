/**
 * content-worker: đường ống lập chỉ mục NỘI DUNG TỆP, chạy bất đồng bộ qua hàng đợi Kafka.
 *
 *   node (upload) ──outbox──▶ Kafka dms.dept.<code>.document ──▶ [content-worker × N] ──▶ node PUT /internal/documents/:id/content
 *
 * - Consumer group `content-indexer`: chạy N bản thì Kafka tự chia partition cho từng bản (scale ngang),
 *   một bản chết thì partition của nó được giao lại cho bản còn sống.
 * - At-least-once + idempotent: offset chỉ commit sau khi xử lý xong; ghi lại cùng một phiên bản là vô hại.
 * - Thử lại 3 lần (backoff), sau đó đẩy vào DLQ `dms.dlq.content` để không nghẽn partition.
 * - Worker KHÔNG lưu gì: tải tệp qua API nội bộ của node (có audit), trích văn bản trong bộ nhớ, ghi kết quả
 *   về chính node chủ sở hữu. Nội dung tệp không nằm ở thành phần dùng chung nào.
 * - Topic của phòng ban mới được dò tự động (pattern), không cần cấu hình lại.
 */
import * as http from 'http';
import * as client from 'prom-client';
import { Admin, Consumer, EachMessagePayload, Kafka, Producer, logLevel } from 'kafkajs';
import { extractText } from './extract';

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[content-worker] Thiếu biến môi trường bắt buộc: ${name}`);
    process.exit(1);
  }
  return v;
}

const BROKERS = env('KAFKA_BROKERS').split(',').filter(Boolean);
const TOKEN = env('INTERNAL_SERVICE_TOKEN');
const REGISTRY_URL = env('REGISTRY_URL');
const GROUP = process.env.KAFKA_GROUP_ID || 'content-indexer';
const PORT = Number(process.env.PORT || 3010);
const MAX_BYTES = Number(process.env.MAX_FILE_BYTES || 20 * 1024 * 1024);
const MAX_ATTEMPTS = 3;
const TOPIC_PATTERN = /^dms\.dept\.([a-z0-9_]+)\.document$/;
const DLQ_TOPIC = 'dms.dlq.content';
const WORKER_ID = process.env.HOSTNAME || `worker-${process.pid}`;

const log = (msg: string) => console.log(`${new Date().toISOString()} [${WORKER_ID}] ${msg}`);

// ---------------------------------------------------------------- metrics
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'dms_' });
const jobsTotal = new client.Counter({
  name: 'dms_content_jobs_total',
  help: 'Số việc lập chỉ mục nội dung theo kết quả',
  labelNames: ['department', 'status'],
  registers: [registry],
});
const jobSeconds = new client.Histogram({
  name: 'dms_content_job_duration_seconds',
  help: 'Thời gian xử lý một tệp (tải + trích + ghi)',
  labelNames: ['extractor'],
  buckets: [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
const assignedPartitions = new client.Gauge({
  name: 'dms_content_assigned_partitions',
  help: 'Số partition Kafka đang được giao cho bản worker này',
  registers: [registry],
});

// ---------------------------------------------------------------- registry lookup
let endpoints: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
async function endpointOf(code: string): Promise<string> {
  if (Date.now() - endpoints.at > 10000 || !endpoints.map.has(code)) {
    const res = await fetch(`${REGISTRY_URL}/registry/internal/departments`, {
      headers: { 'x-service-token': TOKEN },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Registry trả HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ code: string; endpoint: string }>;
    endpoints = { at: Date.now(), map: new Map(rows.filter((r) => r.endpoint).map((r) => [r.code, r.endpoint])) };
  }
  const ep = endpoints.map.get(code);
  if (!ep) throw new Error(`Phòng ban ${code} chưa có endpoint trong Registry`);
  return ep;
}

// ---------------------------------------------------------------- xử lý một sự kiện
interface DocEvent {
  documentId: number;
  fileName?: string | null;
  mimeType?: string | null;
  versionNo?: number;
  deleted?: boolean;
  contentIndexedVersion?: number | null;
}

function parse(raw: string): DocEvent {
  let v: any = JSON.parse(raw);
  if (typeof v === 'string') v = JSON.parse(v);
  if (v?.payload && typeof v.payload === 'object' && v.documentId === undefined) v = v.payload;
  if (typeof v?.documentId !== 'number') throw new Error('Sự kiện không đúng hợp đồng document v1');
  return v as DocEvent;
}

type Outcome = 'indexed' | 'skipped' | 'unsupported' | 'unreadable';

// Chống xử lý trùng trong một bản worker: sự kiện CŨ của cùng một phiên bản tệp (tạo, sửa metadata, resync)
// không mang cờ contentIndexedVersion nên nếu không nhớ thì mỗi sự kiện lại tải và trích tệp một lần.
// Chỉ là tối ưu: tính đúng đắn vẫn dựa vào việc ghi idempotent ở node.
const done = new Map<string, number>();
const DONE_MAX = 20000;
function remember(key: string) {
  if (done.size >= DONE_MAX) done.delete(done.keys().next().value as string);
  done.set(key, Date.now());
}

async function processEvent(code: string, ev: DocEvent): Promise<{ outcome: Outcome; extractor: string }> {
  const version = ev.versionNo ?? 1;
  // Không có tệp, đã xóa, hoặc phiên bản này đã được lập chỉ mục (sự kiện do chính worker gây ra) -> bỏ qua
  if (ev.deleted || !ev.fileName || ev.contentIndexedVersion === version) return { outcome: 'skipped', extractor: 'none' };
  const key = `${code}:${ev.documentId}:${version}`;
  if (done.has(key)) return { outcome: 'skipped', extractor: 'none' };

  const base = await endpointOf(code);
  const res = await fetch(
    `${base}/internal/files/${ev.documentId}/stream?version=${version}&purpose=index&actor=content-worker`,
    { headers: { 'x-service-token': TOKEN }, signal: AbortSignal.timeout(20000) },
  );
  if (res.status === 404) return { outcome: 'skipped', extractor: 'none' }; // tài liệu/phiên bản không còn
  if (!res.ok) throw new Error(`Tải tệp: HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') || 0);
  let text = '';
  let extractor = 'too-large';
  if (declared <= MAX_BYTES) {
    const buf = Buffer.from(await res.arrayBuffer());
    try {
      ({ text, extractor } = await extractText(buf, ev.fileName, ev.mimeType || ''));
    } catch (err: any) {
      // Tệp hỏng là lỗi VĨNH VIỄN của dữ liệu: thử lại không có ích và không nên vào DLQ.
      // Ghi nhận để phiên bản này không bị xử lý lại; DLQ chỉ dành cho lỗi hạ tầng (mạng, node, Kafka).
      extractor = 'unreadable';
      log(`${code} #${ev.documentId}: không đọc được tệp "${ev.fileName}" (${String(err.message).slice(0, 80)})`);
    }
  } else {
    await res.body?.cancel();
  }

  const put = await fetch(`${base}/internal/documents/${ev.documentId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-service-token': TOKEN },
    body: JSON.stringify({ versionNo: version, text, extractor }),
    signal: AbortSignal.timeout(15000),
  });
  if (!put.ok) throw new Error(`Ghi nội dung: HTTP ${put.status}`);
  const body = (await put.json()) as { applied: boolean };
  remember(key);
  if (!body.applied) return { outcome: 'skipped', extractor };
  return { outcome: extractor === 'unreadable' ? 'unreadable' : text ? 'indexed' : 'unsupported', extractor };
}

// ---------------------------------------------------------------- Kafka
const kafka = new Kafka({ clientId: `dms-content-worker-${WORKER_ID}`, brokers: BROKERS, logLevel: logLevel.WARN });
let admin: Admin;
let producer: Producer;
let consumer: Consumer | null = null;
let topics: string[] = [];
let restarting = false;
let stopped = false;
let processed = 0;

async function handle({ topic, partition, message }: EachMessagePayload) {
  const code = topic.match(TOPIC_PATTERN)![1].toUpperCase();
  const raw = message.value?.toString('utf8') ?? '';
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const ev = parse(raw);
      const { outcome, extractor } = await processEvent(code, ev);
      jobsTotal.inc({ department: code, status: outcome });
      if (outcome !== 'skipped') {
        jobSeconds.observe({ extractor }, (Date.now() - started) / 1000);
        log(`${code} #${ev.documentId} v${ev.versionNo ?? 1} -> ${outcome} (${extractor}, ${Date.now() - started} ms, ${topic}[${partition}]@${message.offset})`);
      }
      processed++;
      return;
    } catch (err: any) {
      lastError = err;
      log(`LỖI lần ${attempt}/${MAX_ATTEMPTS} ${topic}[${partition}]@${message.offset}: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt * attempt));
    }
  }

  // Hết số lần thử: chuyển vào DLQ rồi đi tiếp (không chặn các tài liệu phía sau)
  await producer.send({
    topic: DLQ_TOPIC,
    messages: [
      {
        key: message.key,
        value: message.value,
        headers: { error: String(lastError?.message).slice(0, 500), sourceTopic: topic, sourcePartition: String(partition), sourceOffset: String(message.offset), worker: WORKER_ID },
      },
    ],
  });
  jobsTotal.inc({ department: code, status: 'dlq' });
  log(`Đã chuyển ${topic}[${partition}]@${message.offset} vào DLQ ${DLQ_TOPIC}`);
}

async function refreshSubscriptions() {
  if (stopped || restarting) return;
  try {
    const found = (await admin.listTopics()).filter((t) => TOPIC_PATTERN.test(t)).sort();
    if (found.length === 0 || found.join(',') === topics.join(',')) return;
    restarting = true;
    log(`Topic thay đổi: [${topics.join(', ')}] -> [${found.join(', ')}]`);
    if (consumer) await consumer.disconnect().catch(() => undefined);
    const c = kafka.consumer({ groupId: GROUP, allowAutoTopicCreation: false });
    await c.connect();
    for (const t of found) await c.subscribe({ topic: t, fromBeginning: true });
    c.on(c.events.GROUP_JOIN, (e) => {
      const a = e.payload.memberAssignment as Record<string, number[]>;
      const n = Object.values(a).reduce((s, p) => s + p.length, 0);
      assignedPartitions.set(n);
      log(`Được giao ${n} partition: ${Object.entries(a).map(([t, p]) => `${t.replace('dms.dept.', '').replace('.document', '')}[${p.join(',')}]`).join(' ')}`);
    });
    await c.run({ partitionsConsumedConcurrently: 3, eachMessage: handle });
    consumer = c;
    topics = found;
  } catch (err: any) {
    log(`Dựng consumer lỗi: ${err.message}`);
  } finally {
    restarting = false;
  }
}

async function main() {
  http
    .createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(await registry.metrics());
      } else if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'content-worker', worker: WORKER_ID, group: GROUP, topics, processed }));
      } else {
        res.writeHead(404);
        res.end();
      }
    })
    .listen(PORT, () => log(`content-worker lắng nghe :${PORT} (group=${GROUP})`));

  let delay = 1000;
  for (;;) {
    try {
      admin = kafka.admin();
      await admin.connect();
      producer = kafka.producer();
      await producer.connect();
      break;
    } catch (err: any) {
      log(`Chưa kết nối được Kafka (${err.message}), thử lại sau ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
  await refreshSubscriptions();
  setInterval(() => void refreshSubscriptions(), Number(process.env.TOPIC_POLL_MS || 5000));
}

async function shutdown() {
  stopped = true;
  log('Đang tắt: rời consumer group để partition được giao lại ngay');
  await consumer?.disconnect().catch(() => undefined);
  await producer?.disconnect().catch(() => undefined);
  await admin?.disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
