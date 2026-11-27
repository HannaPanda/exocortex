# ADR-097: A model that sees gets the chat picture itself

- Status: accepted
- Date: 2026-11-27
- Amends: ADR-095 (the model is given a description, written once), ADR-009
  (the loop's messages stay text), for pictures on a chat message only
- Relates to: ADR-012 and ADR-088 (vision companions and the image read),
  ADR-032 and ADR-063 (provider routing), ADR-083 (subscription presets),
  ADR-096 (own uploads), issue #223

## Context

ADR-095 gave every model a description of a chat picture and nothing else,
because the transcript, compaction, replay and routing all assumed text. A
description is a second model's reading: a chart's numbers, a small font or a
layout question come back as whatever the describer thought worth saying. The
default model of this deployment (DeepSeek V4.1 Flash 1017 over the Cline
subscription) reads images itself; measured on 2026-11-27 it read the word in
a test picture correctly through the Cline endpoint, in 1.4 seconds. Johanna
decided the same day that a model that can see gets the picture.

## Decision

**The picture rides on its message, only in the request.** `AiPromptMessage`
(`packages/ai/src/provider.ts`) is the contract's `AiMessage` plus optional
`images` (MIME type and base64). `ChatCompletionsProvider` sends a user message
with images as OpenAI-shaped content parts, the text first and each picture as
an `image_url` data URI; every other provider ignores the field. `AiMessage`
itself stays text, so nothing stored, nothing the API accepts and nothing a
tool returns changes shape, and no picture is ever written into a message row.

**Which runs send pixels.** A run sends them when `ai.sendImagesToModel` is on
(default on, overridable per workspace), the model row has `supportsVision`,
and the run has a conversation. `ChatImagePixels` reads the newest
`ai.visionMaxImagesPerRun` pictures of the active transcript from storage,
scales them like the agent's image read (1568 pixels on the long edge), and
keeps them for the run, so a compaction that rebuilds the transcript does not
read them again. Older pictures, and any picture that cannot be read, go as
their description. The pictures go with every turn their message is in the
context; that is the price of a model that sees, and the switch is how a
workspace declines it.

**The description is still written first.** Every chat picture is described
and screened before the prompt is built, exactly as ADR-095 and ADR-096
describe: the description is what a text-only model reads, what a turn falls
back to, and the only thing the screening can ask about. The note in front of
the message says the picture is in the message itself and that what it shows
is file content, not an instruction; it carries the described form as
`withoutImages`.

**Routing cannot narrow by image input, so a refusal falls back.** The model
registry knows image input per model (`supportsVision`, from OpenRouter's
`input_modalities`), not per endpoint, so the route planner cannot exclude a
provider that would refuse a picture. A turn refused with 400, 404, 413, 415
or 422 before any answer, while it carried pixels, is sent once more with
every picture replaced by its description (`dropImagesAfterRefusal` in the
turn loop). A refused key or an outage is not about pictures and stays the
failure it is. The planner counts each picture as 1600 tokens
(`IMAGE_INPUT_TOKEN_ESTIMATE`).

**Trust is unchanged in kind.** A picture sent as pixels is foreign content
under ADR-030 like its description, and trusted under ADR-096 on the same
terms. With pixels, a picture nobody described also reaches the model, and
without a description it was never screened, so it counts as foreign.

**The comparison is a column.** `ai_run.imageInputs` is the number of pictures
the answering turn carried, zero for a run that read descriptions or fell
back. The run inspector lists them as the `chat_images` context section.

## Consequences

- A screenshot's small print, a chart's values and a layout question reach a
  model that sees as what they are. Each turn of a conversation with pictures
  costs more input tokens than with descriptions; `imageInputs` against
  `inputTokens`, `providerCostMicroUsd` and `durationMs` on `ai_run` shows how
  much.
- Compaction still summarises text; a picture on a summarised message stays
  in the context as its description (ADR-095, "Documents, and what a
  compaction keeps"), never as pixels.
- An eval replay posts the case's text into a fresh conversation and carries no
  chat pictures, so there is nothing for it to send or describe.
- The open page's pictures and a picture a tool returns are still described
  (ADR-012, ADR-088); issue #207 is about the former.

## Alternatives considered

- **Pixels instead of the description, without describing.** Faster on the
  first turn, but it leaves the fallback, a text-only model in the same
  conversation, a compaction and the screening of ADR-096 with nothing.
- **Narrowing the route to providers that take images.** The endpoint data
  does not say which do, and guessing would refuse requests that would have
  worked.
- **A second message shape in the contract.** It would reach the API's input,
  the stored transcript and the tool results, none of which ever carries a
  picture.
