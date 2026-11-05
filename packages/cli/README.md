# @openliturgy/cli

Command-line validator for OpenLiturgy Standard packages.

```bash
ols validate ./package            # full six-layer validation (a file validates one document)
ols validate ./package --self-test
ols pack ./package                # pin every document by digest and write manifest.digest
ols verify ./package              # integrity check: everything pinned and unchanged
ols lock ./package                # pin dependencies from ols_packages/<name> in ols.lock.json
ols keygen --out key.pem          # new Ed25519 signing key; prints the public key
ols sign ./package --key key.pem  # sign a packed package (or pass an approval file)
ols verify ./package --keyring keyring.json  # also require trusted signatures and approvals
ols diff ./base ./edited [--overlay id]   # entity-level change set (or overlay)
ols apply overlay.json --base ./base --out ./customized
ols merge ./base ./ours ./theirs --out ./merged
ols migrate ./package [--dry-run]         # rewrite pre-1.1 conventions
ols schemas refresh
```
