-- DropForeignKey
ALTER TABLE "entry" DROP CONSTRAINT "fk_entry_phase";

-- DropForeignKey
ALTER TABLE "phase" DROP CONSTRAINT "fk_project";

-- AlterTable
ALTER TABLE "entry" DROP COLUMN "phase_id",
ADD COLUMN     "project_phase_id" INTEGER;

-- AlterTable
ALTER TABLE "phase" DROP COLUMN "project_id",
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "project_phase" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "phase_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_phase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_phase_project_id_phase_id_key" ON "project_phase"("project_id", "phase_id");

-- AddForeignKey
ALTER TABLE "entry" ADD CONSTRAINT "fk_entry_project_phase" FOREIGN KEY ("project_phase_id") REFERENCES "project_phase"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_phase" ADD CONSTRAINT "fk_project_phase_project" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_phase" ADD CONSTRAINT "fk_project_phase_phase" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

