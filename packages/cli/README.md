# @openliturgy/cli

Command-line validator for OpenLiturgy Standard packages.

```bash
ols validate ./package            # full six-layer validation (a file validates one document)
ols validate ./package --self-test
ols pack ./package                # pin every document by digest and write manifest.digest
ols verify ./package              # integrity check: everything pinned and unchanged
ols schemas refresh
```
