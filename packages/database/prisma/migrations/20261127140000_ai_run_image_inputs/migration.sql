-- Pictures from the chat a run sent to the model as pixels (issue #223, ADR-097).
ALTER TABLE "ai_run" ADD COLUMN "imageInputs" INTEGER NOT NULL DEFAULT 0;
