# Convenience targets. Each one only calls a script, so on Windows without make you can run the
# command on the right directly.
PY ?= python

.PHONY: eval eval-retrieval eval-sweep eval-report eval-test eval-validate eval-unit eval-email backend-verify

# Everything: create .env if missing, start the stack, run the evaluation, write docs/benchmarks.md.
eval:
	$(PY) eval/run_eval.py all

# Retrieval metrics only (minutes instead of most of an hour); the stack must be running.
eval-retrieval:
	$(PY) eval/run_eval.py run --retrieval-only

# Chunk-size experiment (retrieval only); restarts the backend for each size.
eval-sweep:
	$(PY) eval/run_eval.py sweep

eval-report:
	$(PY) eval/run_eval.py report

# The locked test set. Run it only once settings are final: every run is logged.
eval-test:
	$(PY) eval/run_eval.py run --set test

# Email classification on the synthetic set (NFR-09.07); the stack must be running.
eval-email:
	$(PY) eval/run_eval.py email

eval-validate:
	$(PY) eval/run_eval.py validate

eval-unit:
	$(PY) -m unittest discover -s eval/tests

backend-verify:
	cd backend && ./mvnw verify
