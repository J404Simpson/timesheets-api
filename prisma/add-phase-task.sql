-- CreateTable
CREATE TABLE "phase_task" (
    "id" SERIAL NOT NULL,
    "phase_id" INTEGER NOT NULL,
    "task_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phase_task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "phase_task_phase_id_task_id_key" ON "phase_task"("phase_id", "task_id");

-- AddForeignKey
ALTER TABLE "phase_task" ADD CONSTRAINT "fk_phase_task_phase" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "phase_task" ADD CONSTRAINT "fk_phase_task_task" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

