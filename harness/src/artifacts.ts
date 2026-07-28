// Where artifact *content* lives. Metadata always stays in the Store; large content can go to
// disk or S3 instead of inline. Config: MYCEL_ARTIFACTS = inline (default) | fs | s3.
//   inline — content is stored in the Store (zero setup)
//   fs     — content written to MYCEL_ARTIFACTS_DIR (default .mycel/artifacts)
//   s3     — content written to MYCEL_ARTIFACTS_BUCKET (needs @aws-sdk/client-s3 + AWS creds)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArtifactBackend {
  /** When true, content is stored inline in the Store and put/get here are no-ops. */
  inline: boolean;
  put(id: string, content: string): Promise<void>;
  get(id: string): Promise<string | null>;
}

class InlineBackend implements ArtifactBackend {
  inline = true;
  async put(): Promise<void> {}
  async get(): Promise<string | null> {
    return null;
  }
}

class FsBackend implements ArtifactBackend {
  inline = false;
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async put(id: string, content: string): Promise<void> {
    writeFileSync(join(this.dir, id), content);
  }
  async get(id: string): Promise<string | null> {
    const p = join(this.dir, id);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
}

// SDK dynamically imported so the kernel has no hard dependency on it.
class S3Backend implements ArtifactBackend {
  inline = false;
  private constructor(
    private bucket: string,
    private client: any,
    private mod: any,
  ) {}
  static async create(bucket: string): Promise<S3Backend> {
    const pkg = "@aws-sdk/client-s3";
    const mod: any = await import(pkg);
    return new S3Backend(bucket, new mod.S3Client({}), mod);
  }
  async put(id: string, content: string): Promise<void> {
    await this.client.send(
      new this.mod.PutObjectCommand({ Bucket: this.bucket, Key: `artifacts/${id}`, Body: content }),
    );
  }
  async get(id: string): Promise<string | null> {
    try {
      const r = await this.client.send(
        new this.mod.GetObjectCommand({ Bucket: this.bucket, Key: `artifacts/${id}` }),
      );
      return await r.Body.transformToString();
    } catch {
      return null;
    }
  }
}

let cached: ArtifactBackend | null = null;

export async function getArtifactBackend(): Promise<ArtifactBackend> {
  if (cached) return cached;
  const kind = process.env.MYCEL_ARTIFACTS ?? "inline";
  if (kind === "fs") {
    cached = new FsBackend(process.env.MYCEL_ARTIFACTS_DIR ?? ".mycel/artifacts");
  } else if (kind === "s3") {
    cached = await S3Backend.create(process.env.MYCEL_ARTIFACTS_BUCKET ?? "");
  } else {
    cached = new InlineBackend();
  }
  return cached;
}
