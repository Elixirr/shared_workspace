import { Prisma } from "@prisma/client";
import { prisma } from "../db/client";

type RunIdempotentStageInput<T> = {
  key: string;
  stage: string;
  campaignId: string;
  leadId: string;
  workerName: string;
  run: () => Promise<T>;
};

type RunIdempotentStageOutput<T> = {
  executed: boolean;
  result: T | null;
};

const isJsonObject = (value: unknown): value is Prisma.JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const runIdempotentStage = async <T>(
  input: RunIdempotentStageInput<T>
): Promise<RunIdempotentStageOutput<T>> => {
  const existing = await prisma.idempotencyKey.findUnique({
    where: { key: input.key }
  });

  if (existing) {
    const metadata = existing.result;
    if (isJsonObject(metadata) && "value" in metadata) {
      return { executed: false, result: (metadata.value as T) ?? null };
    }

    console.log(
      "[%s][%s][%s] idempotency hit for key=%s (in-flight/unknown), skipping",
      input.campaignId,
      input.leadId,
      input.workerName,
      input.key
    );
    return { executed: false, result: null };
  }

  await prisma.idempotencyKey.create({
    data: {
      key: input.key,
      stage: input.stage,
      campaignId: input.campaignId,
      leadId: input.leadId
    }
  });

  try {
    const result = await input.run();

    await prisma.idempotencyKey.update({
      where: { key: input.key },
      data: {
        result: {
          value: result as Prisma.InputJsonValue
        }
      }
    });

    return { executed: true, result };
  } catch (error) {
    await prisma.idempotencyKey.delete({
      where: { key: input.key }
    });

    throw error;
  }
};
