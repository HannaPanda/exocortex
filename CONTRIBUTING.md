# Contributing

Thank you for looking. Two things are different here from most repositories, and
both are worth knowing before you spend an evening on a pull request.

## eXocortex is source available, not open source

`LICENSE` is PolyForm Noncommercial 1.0.0. You may read, run, change and pass on
the code for any noncommercial purpose, including as a charity, a school or a
public body. Commercial use needs a separate licence, and asking for one is
welcome (johanna@hannapanda.de) rather than hopeless.

This is a deliberate choice and not an oversight: the licence keeps the decision
about commercial use with the author. It also means the project may not be
described as open source, because a restriction on the field of use is exactly
what that term rules out.

## Contributions are licensed to the author

By opening a pull request you grant Johanna a perpetual, worldwide,
irrevocable, royalty-free, transferable and sublicensable right to use,
reproduce, modify, distribute and relicense your contribution, under any terms,
including terms different from `LICENSE` and including commercial licences. You
keep your own copyright; you are granting a licence, not signing it away.

You also confirm that the contribution is yours to give: that you wrote it, or
that you have the right to submit it, and that no employer, client or third
party holds rights that would contradict the grant above.

The reason is the licence, not appetite for paperwork. A source-available
project only works while one person can still relicense the whole of it: to sell
a commercial licence, to grant an individual exception (`LICENSE-GRANTS.md`), or
to open it up completely one day. A single merged pull request without this
grant makes all three impossible, and the discovery usually comes years later.

If a contribution grows past a few files, expect to be asked for a signed
agreement saying the same thing. Below that size this paragraph and the checkbox
in the pull request template are the record.

## Before you open the pull request

```bash
bash scripts/build.sh
```

That is the whole checklist: hard gates, build, lint, formatting, typecheck and
the tests that need no database. The same script runs in CI, so a green run here
is a green run there. `AGENTS.md` has the rules that the gates cannot check, in
particular that visible UI text is German while code, comments and identifiers
are English, and which documents have to change along with which code.

## What is likely to be merged

Bug fixes, tests, documentation corrections and small well-scoped improvements.

Large features are worth an issue first. This is one person's external brain
before it is a product, and a pull request can be excellent and still not fit
the direction. Being told no after a weekend of work is worse than being told no
in a two-line issue comment, so please use the issue.
