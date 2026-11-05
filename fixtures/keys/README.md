# Test keys

`demo-keyring.json` trusts the public key that signed `fixtures/signed`. It exists only so the test suites and the
TypeScript/Python parity gate can check signature verification. The matching private key was generated in a scratch
directory and never committed; tests that need to sign generate a fresh key at runtime.
