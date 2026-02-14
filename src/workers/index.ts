import "dotenv/config";
import { prisma } from "../db/client";
import { callerWorker } from "./caller";
import { deployerWorker } from "./deployer";
import { emailerWorker } from "./emailer";
import { enricherWorker } from "./enricher";
import { imageGeneratorWorker } from "./image-generator";
import { scraperWorker } from "./scraper";
import { siteGeneratorWorker } from "./site-generator";

const workers = [
  scraperWorker,
  enricherWorker,
  siteGeneratorWorker,
  imageGeneratorWorker,
  deployerWorker,
  emailerWorker,
  callerWorker
];

const shutdown = async (): Promise<void> => {
  await Promise.all(workers.map(async (worker) => worker.close()));
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

console.log(`[workers] running ${workers.length} workers`);
