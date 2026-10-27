"""Observable Agent activities: lifecycle, tool steps, and durable effect relationships."""

import asyncio
import json
from contextvars import ContextVar
from datetime import datetime, timezone

from agents import function_tool
from agents.exceptions import ModelBehaviorError
from agents.tool import default_tool_error_function


def timestamp():
    return datetime.now(timezone.utc).isoformat()


_current_activity = ContextVar("current_agent_activity", default=None)


class ActivityInterrupted(asyncio.CancelledError):
    """The simulation or the Agent configuration invalidated an active generation."""


class ActivityLog:
    def __init__(self, records=None, revision=0):
        self.records = records or []
        self.revision = revision
        self.by_id = {record["id"]: record for record in self.records}
        self.sequence = max((record["sequence"] for record in self.records), default=0)

    def start(self, actor, epoch, session_id):
        self.sequence += 1
        record = {
            "id": f"A{self.sequence:08d}", "sequence": self.sequence,
            "session_id": session_id, "actor_id": actor.id, "actor_name": actor.name,
            "epoch": epoch, "started_at": timestamp(), "finished_at": None,
            "status": "running", "action": None, "outcome": "In progress", "reason": None,
            "partial": False, "summary": "", "intention": "", "mood": "",
            "observed_message_ids": [], "message_ids": [], "order_ids": [],
            "trade_ids": [], "search_ids": [], "steps": [], "reviews": [],
            "observations": [], "effects": [],
        }
        self.records.append(record)
        self.by_id[record["id"]] = record
        return record

    @staticmethod
    def summary(record):
        return {key: value for key, value in record.items()
                if key not in {"steps", "reviews", "observations", "effects"}} | {
                    "step_count": len(record["steps"])}

    def page(self, actor_id=None, before=None, limit=50):
        matching = [record for record in reversed(self.records)
                    if actor_id is None or record["actor_id"] == actor_id]
        eligible = [record for record in matching
                    if before is None or record["sequence"] < before]
        page = eligible[:limit]
        return {"records": [self.summary(record) for record in page], "total": len(matching),
                "next_before": page[-1]["sequence"] if len(eligible) > len(page) else None,
                "revision": self.revision}

    def recover(self):
        changed = False
        for record in self.records:
            finished = timestamp()
            reason = record.get("reason") or "Server restarted before this activity finished"
            if record["status"] == "running":
                completed_action = record.get("action") and any(
                    step["kind"] == "action" and step["status"] == "completed"
                    for step in record["steps"])
                if completed_action:
                    record.update(status="completed", finished_at=finished, reason=None, partial=False)
                else:
                    record.update(status="interrupted", finished_at=finished, reason=reason,
                                  outcome="Interrupted", partial=bool(record["effects"]))
                changed = True
            for step in record["steps"]:
                if step["status"] == "running":
                    step.update(status="interrupted", finished_at=finished, error=reason)
                    changed = True
        if changed:
            self.revision += 1
        return changed


class Activity:
    def __init__(self, board, persona, epoch=0, instruction_snapshot=""):
        self.board, self.persona = board, persona
        self.epoch, self.instruction_snapshot = epoch, instruction_snapshot
        self.read = self.reviewed = self.acted = False
        self.seen_ids = set()
        self.history_entry = None
        self.record = None
        self.step = None
        self._tool_lock = asyncio.Lock()
        self._tool_tasks = set()

    def checkpoint(self):
        self.board.activities.revision += 1
        self.board.private_revision += 1
        self.board.save()

    def interruption_reason(self):
        state = self.board.agent_states.get(self.persona.id)
        if state is None or state["epoch"] != self.epoch:
            return "Agent settings changed"
        if not self.board.running:
            return "Agents paused"
        return "Generation cancelled"

    def check_current(self, require_read=True):
        state = self.board.agent_states.get(self.persona.id)
        if not self.board.running or state is None or state["epoch"] != self.epoch:
            raise ActivityInterrupted(self.interruption_reason())
        if require_read and not self.read:
            raise ValueError("Call read_group before acting")

    def observe_group(self):
        self.read = True
        self.seen_ids = {message["id"] for message in self.board.messages[-45:]}
        self.board.seen[self.persona.id] = self.board.revision
        private = self.board.agent_states[self.persona.id]
        observed_at = timestamp()
        private.update(last_read_at=observed_at, last_read_message_ids=sorted(self.seen_ids),
                       loaded_epoch=self.epoch, loaded_at=observed_at,
                       loaded_instructions=self.instruction_snapshot,
                       loaded_persona=self.persona.model_dump())
        self.record["observed_message_ids"] = sorted(
            set(self.record["observed_message_ids"]) | self.seen_ids)
        self.record["observations"].append({
            "kind": "group", "time": observed_at, "step_id": self.step["id"],
            "revision": self.board.revision, "message_ids": sorted(self.seen_ids),
        })
        self.board.event("read", f"{self.persona.name} read the group", self.persona.id)

    def review(self, summary, intention, mood, memory_note=""):
        state = self.board.agent_states[self.persona.id]
        if memory_note and memory_note not in state["memory"]:
            addition = ("\n" if state["memory"] else "") + "· " + memory_note
            if len(state["memory"] + addition) <= 6000:
                state["memory"] += addition
        state.update(thought_summary=summary, intention=intention, mood=mood, updated_at=timestamp())
        entry = {"time": timestamp(), "activity_id": self.record["id"],
                 "summary": summary, "intention": intention, "mood": mood,
                 "observed_message_ids": sorted(self.seen_ids), "action": "Preparing an action"}
        self.record["reviews"].append(entry)
        self.record.update(summary=summary, intention=intention, mood=mood)
        state["history"].append(entry)
        state["history"] = state["history"][-12:]
        self.history_entry, self.reviewed = entry, True
        return state["memory"]

    def effect(self, kind, entity_id, operation="created"):
        effect = {"kind": kind, "id": entity_id, "operation": operation,
                  "time": timestamp(), "step_id": self.step["id"] if self.step else None}
        self.record["effects"].append(effect)
        field = {"message": "message_ids", "order": "order_ids", "trade": "trade_ids"}.get(kind)
        if field and entity_id not in self.record[field]:
            self.record[field].append(entity_id)

    def add_search(self, record):
        record["activity_id"] = self.record["id"]
        self.record["search_ids"].append(record["id"])
        self.board.search_records.append(record)
        self.checkpoint()

    async def search(self, record, request):
        self.add_search(record)
        try:
            result = await request()
            self.check_current()
            record.update(result, status="completed", result_count=len(result["results"]))
        except asyncio.CancelledError:
            record.update(status="error", error="Search interrupted")
            raise
        except Exception as exc:
            record.update(status="error", error=self.board.social_client.error_text(exc))
        finally:
            record["finished_at"] = timestamp()
            self.checkpoint()
        if record["status"] == "error":
            self.step.update(status="failed", error=record["error"])
        return record

    def finish(self, status, outcome, reason=None):
        if self.record["status"] != "running":
            return
        self.record.update(status=status, outcome=outcome, reason=reason,
                           finished_at=timestamp(), partial=status != "completed" and bool(self.record["effects"]))
        if self.history_entry is not None:
            self.history_entry["action"] = outcome if not reason else f"{outcome}: {reason}"

    async def invoke(self, name, kind, outcome, request):
        if self.record is None:
            raise RuntimeError("An activity must start before its tools run")
        step = {"id": len(self.record["steps"]) + 1, "name": name, "kind": kind,
                "started_at": timestamp(), "finished_at": None, "status": "running"}
        self.record["steps"].append(step)
        task = asyncio.current_task()
        self._tool_tasks.add(task)
        self.checkpoint()
        try:
            async with self._tool_lock:
                self.step = step
                token = _current_activity.set(self)
                try:
                    self.check_current(require_read=kind not in {"read", "inspect"})
                    if self.acted or self.record["status"] != "running":
                        raise ValueError("You already completed an action; wait until your next turn")
                    if kind in {"search", "action"} and not self.reviewed:
                        raise ValueError("Call update_private_state with a brief state summary and intention before acting")
                    result = await request()
                    if step["status"] == "running":
                        step["status"] = "completed"
                    if kind == "read":
                        self.record["observations"][-1]["data"] = json.loads(result)
                    elif kind == "inspect":
                        self.record["observations"].append({"kind": name, "time": timestamp(),
                                                             "step_id": step["id"], "data": json.loads(result)})
                    if kind == "action":
                        self.acted = True
                        self.record.update(action=name, outcome=outcome)
                    return result
                finally:
                    self.step = None
                    _current_activity.reset(token)
        except asyncio.CancelledError:
            step.update(status="interrupted", error=self.interruption_reason())
            raise
        except Exception as exc:
            rejected = isinstance(exc, (ValueError, ModelBehaviorError))
            step.update(status="rejected" if rejected else "failed",
                        error=str(exc)[:300] if rejected else type(exc).__name__)
            raise
        finally:
            step["finished_at"] = timestamp()
            self._tool_tasks.discard(task)
            self.checkpoint()

    async def settle_tools(self):
        pending = [task for task in self._tool_tasks if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def run(self, request, timeout=100):
        """Start one real generation and finalize it on every exit, including task cancellation."""
        self.record = self.board.activities.start(self.persona, self.epoch, self.board.created_at)
        self.board.active.add(self.persona.id)
        self.checkpoint()
        generation = None
        status, outcome, reason = "failed", "No action completed", "Generation ended without a terminal action"
        try:
            generation = asyncio.create_task(request())
            self.board.calls[self.persona.id] = generation
            result = await asyncio.wait_for(generation, timeout=timeout)
            return result
        except asyncio.CancelledError:
            status, outcome, reason = "interrupted", "Interrupted", self.interruption_reason()
            raise
        except TimeoutError:
            status, outcome, reason = "failed", "Timed out", "Generation exceeded its time limit"
            raise
        except Exception as exc:
            status, outcome, reason = "failed", "Failed", type(exc).__name__
            raise
        finally:
            await self.settle_tools()
            if self.acted:
                self.finish("completed", self.record["outcome"])
            else:
                self.finish(status, outcome, reason)
            if generation is not None and self.board.calls.get(self.persona.id) is generation:
                self.board.calls.pop(self.persona.id, None)
            self.board.active.discard(self.persona.id)
            self.checkpoint()


def activity_tool(kind, outcome=None):
    """Keep prerequisite checks, step recording and completion timing out of each tool."""
    def decorate(function):
        tool = function_tool(function, strict_mode=False, failure_error_function=None)
        original = tool.on_invoke_tool

        async def invoke(ctx, arguments):
            try:
                return await ctx.context.invoke(tool.name, kind, outcome, lambda: original(ctx, arguments))
            except Exception as exc:
                return default_tool_error_function(ctx, exc)

        tool.on_invoke_tool = invoke
        return tool
    return decorate


def track_effect(actor_id, kind, entity_id, operation="created"):
    """Join a domain mutation to its active tool before the Board saves both together."""
    activity = _current_activity.get()
    if activity is None or activity.persona.id != actor_id:
        return None
    activity.effect(kind, entity_id, operation)
    return activity.record["id"]
