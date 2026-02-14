"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("../db/client");
const caller_1 = require("./caller");
const deployer_1 = require("./deployer");
const emailer_1 = require("./emailer");
const enricher_1 = require("./enricher");
const image_generator_1 = require("./image-generator");
const scraper_1 = require("./scraper");
const site_generator_1 = require("./site-generator");
const workers = [
    scraper_1.scraperWorker,
    enricher_1.enricherWorker,
    site_generator_1.siteGeneratorWorker,
    image_generator_1.imageGeneratorWorker,
    deployer_1.deployerWorker,
    emailer_1.emailerWorker,
    caller_1.callerWorker
];
const shutdown = async () => {
    await Promise.all(workers.map(async (worker) => worker.close()));
    await client_1.prisma.$disconnect();
    process.exit(0);
};
process.on("SIGINT", () => {
    void shutdown();
});
process.on("SIGTERM", () => {
    void shutdown();
});
console.log(`[workers] running ${workers.length} workers`);
