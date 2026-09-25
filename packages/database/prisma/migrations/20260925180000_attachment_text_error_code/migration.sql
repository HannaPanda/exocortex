-- Why an attachment's text could not be read, as a code every reader words in its
-- own language (issue #98). The English detail stays in "textExtractionError".
ALTER TABLE "attachment" ADD COLUMN "textErrorCode" TEXT;
