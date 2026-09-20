'use client';

import { type UploadAttachmentResponse } from '@exocortex/contracts';

import { uploadRequest } from './client';

/**
 * Uploads a file and returns the **stable** URL to reference it from a document.
 *
 * Not the `downloadUrl` the endpoint also returns: that is a presigned storage URL
 * that expires after five minutes, and a document lives longer than that. The API
 * route below checks the session on every request, so an attachment stays as
 * private as the page it sits on.
 */
export async function uploadAttachment(input: {
  workspaceId: string;
  documentId: string;
  file: File;
}): Promise<{ id: string; src: string; name: string }> {
  const form = new FormData();
  form.append('documentId', input.documentId);
  form.append('file', input.file, input.file.name);

  const { attachment } = await uploadRequest<UploadAttachmentResponse>(
    `/api/workspaces/${input.workspaceId}/attachments`,
    form,
  );

  return {
    // The id as well as the URL: a project asset is bound to a path by id
    // (issue #43), where the editor only ever needs something to put in a src.
    id: attachment.id,
    src: `/api/attachments/${attachment.id}/download`,
    name: attachment.filename,
  };
}
