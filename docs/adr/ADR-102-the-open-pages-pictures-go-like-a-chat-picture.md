# ADR-102: The open page's pictures go like a chat picture

- Status: accepted
- Date: 2026-11-28
- Amends: ADR-012 (page pictures described per run, never cached; a model
  that sees skipped), ADR-096 ("page pictures described per run stay
  foreign"), ADR-097 (pixels for chat pictures only)
- Relates to: ADR-030 (foreign content), ADR-083 (subscription presets),
  ADR-088 (the image read and its describer), ADR-092 (shared pages),
  issue #207

## Context

A run that stands on a page with pictures described them before its first
turn (ADR-012), unless the run's model was marked `supportsVision`: then the
describer was skipped because "the model sees images itself". It did not.
The loop's messages were text, so a model that sees knew less about the open
page than a text-only one with a companion. The deployment's default model
(DeepSeek V4.1 Flash over the Cline subscription) is such a model, so the gap
was the everyday case: "Was zeigt das Bild?" on a page with a picture was
answered by a model that had been told nothing about it.

Since then ADR-097 gave chat pictures a request-only image part, and ADR-096
made a person's own screened upload trusted for that person. Johanna's
decision behind ADR-096 ("Wenn der User was hochlädt, darf der Agent das
normal nutzen") was about the asking person's uploads, not about the place
they were uploaded to.

## Decision

**A page picture goes the way a chat picture goes.** `preparePagePictures`
(`apps/worker/src/processors/ai-run/page-pictures.ts`) reads the first
`ai.visionMaxImagesPerRun` pictures of the open page in page order (only the
types the image read accepts, so no SVG), and then:

1. **Described once, kept on the row.** A picture without
   `Attachment.imageDescription` is scaled like the image read (1568 pixels)
   and described by the same choice a chat picture and a tool's picture use
   (`resolveImageDescriber`): the run's model when it sees images and is not a
   subscription preset, otherwise the conversation's or the model row's
   companion, otherwise the deployment default. A preset's slug never reaches
   the OpenRouter-based describer. The description is written with
   `imageDescribedAt` and `imageDescriptionModel`, so every later run on the
   page reads it for nothing. Replacing a picture uploads a new attachment, so
   a stored description never describes a different picture. A conversation
   that switched its companion off writes no new description, but reads one
   that exists.
2. **Pixels on the person's latest message.** When the run would send a chat
   picture as pixels (`ai.sendImagesToModel` on, the model row's
   `supportsVision`, a conversation), the page's pictures ride on the last
   user message as `AiPromptMessage.images`, behind the chat's own. A system
   message can carry no image part in the OpenAI shape, and a synthetic user
   message would put words in the person's mouth, so the person's question
   carries them and the note in front of the conversation says where they are
   and that they come from the page. Chat and page share one count: the
   chat's pictures first, the page's in the room left. The note carries its
   described form as `withoutImages`, so ADR-097's refusal fallback answers a
   provider that takes no images with the descriptions. A compaction that
   rebuilds the transcript puts the same pixels back on the latest message.
3. **Never neither.** A picture that can be neither sent nor described is
   named in the note as unseen, with the instruction to say so rather than
   guess.
4. **Trust per picture, by ADR-096.** A page picture is trusted for the reader
   who uploaded it, on a page of the run's own workspace, when nobody else
   corrected it, it was not fetched from the web and its description was
   screened clean. Only such a picture is screened (once, after it was
   described, and again while a screening keeps failing): somebody else's
   picture stays foreign whatever a screening says, so asking about it would
   be money for nothing. A page shared from another workspace stays foreign
   however clean (ADR-092). A picture sent as pixels without a description was
   never screened and counts as foreign. Any foreign picture in the prompt
   marks the run as having read attachment content (ADR-030).
5. **Measured apart.** The run inspector names the note as `images` and the
   page's pixels as `page_images` (1600 tokens each, the estimate ADR-097
   uses); `ai_run.imageInputs` counts both kinds.

## Consequences

- The default model answers about a page's pictures from the pictures.
- A run on a page with pictures costs, once per picture, one description by
  the companion (about 0.01 cent with `qwen/qwen3.7-flash` at its registry
  price) and, for the uploader's own pictures, one screening question to the
  decision model; every later run pays neither. A model that sees adds about
  1600 input tokens per picture to every turn of a run on that page, up to the
  shared limit; `ai.sendImagesToModel` off removes that and leaves the stored
  description.
- A run of the default model on a page with somebody else's pictures now
  closes writing under the `guarded` policy, as a text-only model's run always
  did; on a page with the reader's own pictures it keeps writing once they are
  screened clean. Before, the default model's runs read nothing of the
  pictures and therefore locked nothing.
- `imageDescription` is no longer chat-only. The cell-file copy
  (`cell-file-copy.service.ts`) already carries it over; the AI fill reads it
  for a cell file and judges it by the same screening column.
- A picture a tool returns (`exo_attachment_read_image`) is still described
  rather than sent as pixels (ADR-088): a tool result is a tool message, and
  pixels there would need image parts on a role the transport does not give
  them.

## Alternatives considered

- **Describe through the companion only, no pixels** (option 1 in issue #207).
  Closes the gap, but a model that reads a screenshot's small print itself
  would get a second model's paraphrase of it, which ADR-097 already rejected
  for chat pictures.
- **Page pictures always foreign.** Simpler, but it would turn every run of
  the default model on a person's own page with a picture into a run that may
  not write, which is the friction ADR-096 removed for chat files on purpose.
- **A separate limit for page pixels.** Doubles the worst case per turn for no
  reason a person asked for; the chat's own pictures are the ones somebody
  attached to this very question.
- **Describing per run with the question in front of the describer.** A
  sharper description for that one question, paid again on every run; the
  model that sees gets the pixels anyway.
