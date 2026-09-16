# Authorized workspace

This folder is the Computer Agent's sandbox. In Phase 1 the agent can read,
create, modify, move, and (with your explicit approval) delete files **only
inside this folder**. Anything outside it is refused by both the control
plane and the agent.

- `notes/` — working notes and checklists the agent may maintain.
- `reports/` — inspection and verification reports land here.
- `scripts/` — small scripts the agent may run after approval.

Nothing here is source code of WAVES ONE itself. Treat it as operator
territory: the agent's actions inside are fully audited in the Activity feed.
