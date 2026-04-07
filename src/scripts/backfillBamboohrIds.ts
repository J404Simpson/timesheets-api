import "dotenv/config";
import prisma from "../prismaClient";
import { backfillBambooEmployeeIds } from "../services/bamboohrSync";

async function main() {
  const result = await backfillBambooEmployeeIds(prisma, console);
  console.info(
    `BambooHR employee backfill complete. Updated ${result.bambooIdsUpdated} BambooHR ID(s) and ${result.regionsUpdated} region link(s).`
  );
}

main()
  .catch((error) => {
    console.error("BambooHR employee ID backfill failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
