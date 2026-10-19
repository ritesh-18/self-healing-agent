import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Trace, TraceExporter } from "./trace.js";

/**
 * Exports traces to S3-compatible object storage.
 *
 * Traces are large and append-only. A single run's spans, prompts and raw
 * provider responses dwarf the summary rows the dashboard queries, so
 * Postgres holds the index and the payloads live here. MinIO locally speaks
 * the real S3 API, which means the same code runs unchanged against AWS.
 *
 * An export failure must never fail the run that produced it. Observability
 * that can take down the thing it observes is worse than none.
 */
export function createS3Exporter(opts: {
  endpoint?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}): TraceExporter {
  const client = new S3Client({
    region: opts.region ?? "us-east-1",
    ...(opts.endpoint
      ? {
          endpoint: opts.endpoint,
          // MinIO serves path-style URLs; virtual-host style needs DNS.
          forcePathStyle: true,
        }
      : {}),
    credentials: {
      accessKeyId: opts.accessKey,
      secretAccessKey: opts.secretKey,
    },
  });

  // Created lazily on first write rather than by an init container: one less
  // service to depend on, and it survives the bucket being removed later.
  let bucketReady = false;
  async function ensureBucket(): Promise<void> {
    if (bucketReady) return;
    try {
      await client.send(new CreateBucketCommand({ Bucket: opts.bucket }));
    } catch {
      // Already exists, or we lack permission to create it. Either way the
      // put below is the real test.
    }
    bucketReady = true;
  }

  return {
    async export(trace: Trace): Promise<void> {
      // Date-partitioned, so a day's traces can be listed or expired as a
      // unit without scanning the whole bucket.
      const day = new Date().toISOString().slice(0, 10);
      const key = `traces/${day}/${trace.id}.json`;

      try {
        await ensureBucket();
        await client.send(
          new PutObjectCommand({
            Bucket: opts.bucket,
            Key: key,
            Body: JSON.stringify(trace.toJSON()),
            ContentType: "application/json",
          }),
        );
      } catch (err) {
        console.error(
          `[trace] export failed for ${trace.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}

/** Where a trace landed, for the dashboard to link to. */
export function traceKey(traceId: string, day = new Date()): string {
  return `traces/${day.toISOString().slice(0, 10)}/${traceId}.json`;
}

export function exporterFromEnv(): TraceExporter | null {
  const bucket = process.env.S3_BUCKET;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;

  // Tracing is optional; without configuration the system runs untraced
  // rather than failing to start.
  if (!bucket || !accessKey || !secretKey) return null;

  return createS3Exporter({
    endpoint: process.env.S3_ENDPOINT,
    bucket,
    accessKey,
    secretKey,
    region: process.env.S3_REGION,
  });
}
