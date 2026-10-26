---
name: Feature request
about: Propose a new capability or a change to an existing one
title: ''
labels: enhancement
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: What are you trying to do that s200 cannot express today, and why do existing batteries/middleware fall short?
      placeholder: I'm building … and I cannot …
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed solution
      description: The API shape you would want — a snippet of how it would be used helps most. Keep the data + functions paradigm in mind — batteries are factories returning middleware.
      placeholder: |
        ```ts
        import { … } from 's200/<battery>';
        use(app, …);
        ```
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives considered
      description: Workarounds you tried (custom middleware, other batteries, another framework) and why they are not good enough.
    validations:
      required: true
