# Security — blast radius of shared bricks

Reuse has a security cost: **a bug in a brick propagates to every skill that uses it.**
(Independent audits of agent-skill marketplaces report systemic, cascading risk through the
dependency graph — the more shared and interconnected the pieces, the larger the combined
attack surface.)

## Principles
- Each brick declares what it does **not** guarantee (`guarantees-not` in its frontmatter).
- A change to a **high-reuse** brick deserves heavier review, proportional to how many skills
  depend on it. Use `forge` reference counts to know the blast radius before editing.
- The build is deterministic and auditable: the generated output is versioned and reviewable.
- `forge remove` never deletes a shared brick — only bricks a single skill exclusively owns.

## Reporting a vulnerability
Open a private security advisory on the repository, or contact the maintainer. Please do not
file public issues for undisclosed vulnerabilities.
