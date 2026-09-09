"""Evidence-preserving, role-specific projections; no send path or completion gate.

Saves each parent reconstructing milestone/ETA/risk context from raw messages.
The event ledger stays authoritative; these views can be rebuilt at any time.
"""
import copy
from p5lib import canonical, csha, task_binding

LABELS = {'pending_review': '已交付待审', 'completed': '本分支审核通过',
          'in_progress': '实施中', 'blocked': '受阻', 'paused': '暂停', 'resume_pending': '控制已解除，待新版接单',
          'accepted': '已接单', 'queued': '排队', 'unknown': '尚无已确认进展', 'failed': '失败'}
REPORT_FIELDS = {'milestone', 'detail', 'verified', 'blockers', 'risks', 'dependencies', 'eta', 'decisions'}

def validate_report(report):
    if not isinstance(report, dict) or set(report) != REPORT_FIELDS:
        raise ValueError('task_report requires exact milestone/detail/verified/blockers/risks/dependencies/eta/decisions')
    for field in ('milestone', 'detail', 'eta'):
        if not isinstance(report[field], str) or not report[field].strip(): raise ValueError('empty report '+field)
    for field in ('verified', 'blockers', 'dependencies', 'decisions'):
        if not isinstance(report[field], list) or any(not isinstance(x, str) or not x.strip() for x in report[field]):
            raise ValueError('invalid report '+field)
    if not isinstance(report['risks'], list): raise ValueError('invalid risks')
    seen = set()
    for risk in report['risks']:
        if not isinstance(risk, dict) or set(risk) != {'id', 'severity', 'text'}: raise ValueError('invalid risk fields')
        if not isinstance(risk['id'], str) or not risk['id'] or risk['id'] in seen: raise ValueError('duplicate/empty risk id')
        if risk['severity'] not in ('major', 'critical', 'normal') or not isinstance(risk['text'], str) or not risk['text']:
            raise ValueError('invalid risk severity/text')
        seen.add(risk['id'])
    if len(canonical(report).encode()) > 48000: raise ValueError('report too large; never silently truncate risks')
    return report

def rows(st, task):
    d = st.get('delegation') or {}; b = task_binding(st, task) or {}
    store = (d.get('version_tasks') or {}).get(str(b.get('task_version')), {}) if b.get('migration_id') else d.get('tasks', {})
    return [r for r in store.values() if r.get('task_id') == task and r.get('root_request_id') == b.get('root_request_id')]

def build(st, task, tier, binding_lookup=None):
    if tier not in ('near', 'middle', 'root'): raise ValueError('unknown summary tier')
    b = task_binding(st, task) or {}; branches = rows(st, task); chat = st['chat_id']
    own = next((r for r in branches if r['origin_chat'] == chat), {})
    risks, evidence, milestones, blockers, dependencies, decisions, details, audit_risks = [], [], [], [], [], [], [], []
    states = []
    for row in sorted(branches, key=lambda r: r['origin_chat']):
        states.append({'origin_chat': row['origin_chat'], 'state': row.get('state', 'unknown'),
                       'label': LABELS.get(row.get('state'), row.get('state')),
                       'event_version': row.get('applied_event_version', 0),
                       'sync_status': row.get('sync_status'), 'last_received_at': row.get('last_received_at')})
        for ev in row.get('events', []):
            report = ev.get('source_report')
            if not report: continue
            validate_report(report)
            if not ev.get('applied'):
                audit_risks.extend(dict(r,origin_chat=ev['origin_chat'],evidence_message_id=ev['evidence_message_id'],
                    reject_reason=ev.get('reject_reason'),applied=False) for r in report['risks'])
                continue
            ob = (binding_lookup(row['origin_chat'], task, ev['task_version']) if binding_lookup else b) or {}
            evidence.append({'event_id': ev['event_id'], 'origin_chat': ev['origin_chat'],
                'task_version': ev['task_version'], 'event_version': ev['event_version'],
                'evidence_message_id': ev['evidence_message_id'], 'source_message_id': ev.get('source_message_id'),
                'result_message_id': ev['evidence_message_id'] if ev['event_type'] in ('result_pending_review', 'review_passed') else None,
                'delivery_message_id': ob.get('delivery_message_id'), 'accepted_message_id': ob.get('accepted_message_id'),
                'documents': [{'name': d['name'], 'sha256': d['sha256']} for d in ob.get('version_plan', {}).get('documents', [])],
                'source_report_sha256': csha(report)})
            # Keep every previously reported risk. Explicit resolution is a
            # later protocol extension, never an implicit consequence of silence.
            for risk in report['risks']:
                item = dict(risk, origin_chat=ev['origin_chat'], evidence_message_id=ev['evidence_message_id'])
                if item not in risks: risks.append(item)
            if ev['event_version'] != row.get('applied_event_version'): continue
            milestones.append({'origin_chat': ev['origin_chat'], 'milestone': report['milestone'],
                'state': row['state'], 'label': LABELS.get(row['state'], row['state']), 'eta': report['eta']})
            blockers.extend(report['blockers']); dependencies.extend(report['dependencies']); decisions.extend(report['decisions'])
            details.append({'origin_chat': ev['origin_chat'], 'detail': report['detail'], 'verified': report['verified']})
    result = {'schema_version': 1, 'tier': tier, 'chat_id': chat, 'root_request_id': b.get('root_request_id'),
        'task_id': task, 'task_version': b.get('task_version'), 'observation': 'last_known',
        'node_state': own.get('state', 'unknown'), 'node_label': LABELS.get(own.get('state', 'unknown'), '未知'),
        'whole_task_complete': False, 'branch_states': states, 'milestones': milestones,
        'risks': risks, 'audit_risks':audit_risks, 'decisions': list(dict.fromkeys(decisions)), 'evidence': evidence}
    if tier == 'near': result.update(details=details, verification_and_blockers=list(dict.fromkeys(blockers)))
    if tier == 'middle': result.update(dependencies=list(dict.fromkeys(dependencies)), blockers=list(dict.fromkeys(blockers)),
        delivery_impact='存在阻塞，交期需本层确认' if blockers else '未报告交期阻塞；仅截至最后已知事件')
    if tier == 'root': result.update(overall_progress={'known_branches': len(states),
        'delivered_pending_review': sum(r['state'] == 'pending_review' for r in states),
        'reviewed_branches': sum(r['state'] == 'completed' for r in states)},
        major_risks=[r for r in risks if r['severity'] in ('major', 'critical')],
        decision_required=bool(decisions), blockers=list(dict.fromkeys(blockers)))
    return result

def validate_projection(candidate, expected):
    # Exact derived fields, not language variety or shorter length, are the
    # criterion. Corrupted/LLM-authored replacements must fail before sending.
    if candidate.get('whole_task_complete') is not False: raise ValueError('child completion cannot complete whole task')
    if candidate.get('risks') != expected.get('risks'): raise ValueError('risk dropped or rewritten')
    if candidate != expected: raise ValueError('projection not grounded in this node/source snapshot')
    return True

def render(summary):
    title = {'near': '近层执行与验证', 'middle': '本层里程碑/依赖/交期', 'root': '整体进展/重大风险/决策'}[summary['tier']]
    return title+'（最后已知；非整体完成） '+canonical(summary)
