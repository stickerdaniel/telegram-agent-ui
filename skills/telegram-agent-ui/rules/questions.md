# Questions

## Contents

- One question, as the last sentence
- The question names the decision
- A choice of 2 is a yes or no question
- Every question carries --strict
- Close a question once its answer is acted on

---

## One question, as the last sentence

A message asks one question, and the question ends it. The facts the decision needs come before it.

**Incorrect:**

```sh
telegram-agent-ui ask --strict -o Postgres -o SQLite -o MySQL - <<'EOF'
Which database should the migration target? Should I also squash the commits? The schema works on all three.
EOF
```

**Correct:**

```sh
telegram-agent-ui ask --strict -o Postgres -o SQLite -o MySQL - <<'EOF'
The migration in `db/` works on all three databases. Which one should it target?
EOF
```

---

## The question names the decision

The question states what the user decides. The buttons and the reply field carry the way to answer.

**Incorrect:**

```markdown
Should I mock the clock in `login.spec.ts`? Tap Yes or No below.
```

**Correct:**

```markdown
Should I mock the clock in `login.spec.ts`?
```

---

## A choice of 2 is a yes or no question

With 2 options, the question asks whether to take the one you recommend, with `--yes-no`. The reason for the recommendation comes first.

**Incorrect:**

```sh
telegram-agent-ui ask --strict -o 'Retry 3 times' -o 'Mock the clock' - <<'EOF'
How should I fix the flaky `login.spec.ts`?
EOF
```

**Correct:**

```sh
telegram-agent-ui ask --yes-no --strict - <<'EOF'
`login.spec.ts` fails when the real clock crosses a second. Retries hide the race, and a mocked clock removes it. Should I mock the clock?
EOF
```

---

## Every question carries --strict

`ask` runs with `--strict`, so a body with a warning is refused before it is sent. The refusal names the warning, and the rewritten body goes out.

**Incorrect:**

```sh
telegram-agent-ui ask --text - <<<'Release name'
```

**Correct:**

```sh
telegram-agent-ui ask --text --strict - <<<'What should release 2.4 be called?'
```

---

## Close a question once its answer is acted on

After the answer is acted on, `close <ref>` gets one line that names what was done. The message shows it above the folded question and takes no further answer.

**Incorrect:**

```sh
telegram-agent-ui wait k7q2m4xa --seconds 50
# {"status":"answered","answer":{"kind":"choice","index":0,"label":"Postgres"},...}
echo postgres > db.txt
```

**Correct:**

```sh
telegram-agent-ui wait k7q2m4xa --seconds 50
# {"status":"answered","answer":{"kind":"choice","index":0,"label":"Postgres"},...}
echo postgres > db.txt
telegram-agent-ui close k7q2m4xa - <<<'The migration targets Postgres: `db.txt` holds it.'
```
