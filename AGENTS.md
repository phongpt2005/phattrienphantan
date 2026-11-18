# META ASTRYX AGENT GOVERNANCE & ANTI-AI DESIGN SPECIFICATION
# Project: Distributed Document Management System (DMS Enterprise)
# Standard: Meta Astryx Open-Source Enterprise Design Rules (meta/astryx)

This document establishes the canonical, deterministic rules and behavioral constraints for all AI coding agents working on this codebase. Agents MUST strictly adhere to these rules without exception.

---

## 1. ANTI-AI-IFICATION POLICY (NGHIÊM CẤM GIAO DIỆN "AI HÓA")

AI coding models tend to default to a recognizable "AI aesthetic" (glowing neon gradients, floating cards with 32px padding, useless bot icons, bubbly rounded buttons, chat-first thinking). In this corporate DMS system, this behavior is STRICTLY FORBIDDEN.

### FORBIDDEN PATTERNS:
- ❌ **NO AI/Robot Iconography**: Never add sparkle icons (`Sparkles`), bot avatars, brain icons, or chat bubble widgets unless explicitly requested for an AI feature.
- ❌ **NO Floating Toy Cards**: Never use overly rounded corners (`rounded-3xl` or `rounded-[32px]`) or massive blurry shadows (`shadow-2xl` on static cards).
- ❌ **NO Neon or Trendy Consumer Gradients**: Never use purple-to-cyan or pink-to-violet linear gradients (`bg-gradient-to-r from-purple-500 to-indigo-600`).
- ❌ **NO Wasteful Padding**: Never use consumer padding (`py-12`, `p-8` for simple table rows). Enterprise users need to see 15-20 rows of data per screen, not 3 rows.
- ❌ **NO Conversational Hallucinations**: Do not replace standard business action buttons with conversational prompts like "Hỏi tài liệu này..." or "Trò chuyện cùng hồ sơ".

### MANDATORY ENTERPRISE PATTERNS:
- ✅ **High Information Density (Dense Mode)**: Table row height should be 36px-44px. Data cells must be crisp and aligned.
- ✅ **Administrative Typography**: Clean geometric sans (`Plus Jakarta Sans` or `Inter`) for headings/labels; monospace (`JetBrains Mono` or `SFMono`) for document codes (`#DOC-xxx`), transaction IDs, dates, and SHA-256 hashes.
- ✅ **Solid Corporate Colors**: Use authoritative corporate slates, deep navy blues (`#0064e0`, `#075985`, `#0f172a`), crisp white surfaces, and subtle 1px dividers (`#e2e8f0`).
- ✅ **Zero-Context-Loss Inspection (Slide-over Sheet)**: Deep object inspection (viewing hashes, metadata, version history, cross-department share records) must ALWAYS use side-drawers (slide-over sheets) that slide in from the right, preserving the user's scroll position, filters, and list context.
- ✅ **Strict Security & DLP Indicators**: Explicit visual badges for document classification (`BẢO MẬT PHÒNG BAN`, `TOÀN DOANH NGHIỆP`, `CHỈ XEM - DLP`, `ĐƯỢC TẢI VỀ`).

---

## 2. DESIGN TOKENS & ATOMIC STYLING CONTRACT

All UI elements must map directly to the defined semantic tokens:

### Surfaces:
- Canvas: `bg-slate-50` (`#f8fafc`)
- Card & Table Container: `bg-white` (`#ffffff`) with border `border-slate-200` (`#e2e8f0`)
- Table Header & Secondary Surfaces: `bg-slate-100/70` or `bg-slate-50`
- Drawer / Modal Surface: `bg-white` with `border-l border-slate-200` and `shadow-xl`

### Text & Hierarchy:
- Primary Text: `text-slate-900` (`#0f172a`) - Font weight 600/700 for titles
- Secondary Text: `text-slate-600` (`#475569`) - Font weight 500
- Meta / Micro Labels: `text-[11px] text-slate-400 font-bold uppercase tracking-wider`
- Monospace Data: `font-mono text-slate-600 text-xs`

### Status Pills (Compact Badges):
- **Approved / Download Permitted**: `bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold`
- **Read-Only / DLP Restricted**: `bg-blue-50 text-blue-800 border border-blue-200 font-semibold`
- **Pending Review**: `bg-amber-50 text-amber-800 border border-amber-200 font-semibold`
- **Revoked / Rejected**: `bg-red-50 text-red-800 border border-red-200 font-semibold`

---

## 3. BUSINESS ROLE BOUNDARIES (3 TIERS)

Agents modifying authentication, UI, or backend access MUST enforce these 3 distinct tiers:

1. **Staff (Nhân viên)**:
   - Accounts: `hr_staff`, `acc_staff`
   - Scope: Local department files only.
   - Permissions: Create local files, view shared-to-department files, submit access requests for other department files.
   - Prohibitions: **NO share button**, NO approval tab, NO access to executive audit logs.

2. **Manager (Trưởng phòng)**:
   - Accounts: `hr_manager`, `acc_manager`
   - Scope: Full department management + Inter-department approval authority.
   - Permissions: Approve/Reject incoming access requests (`VIEW` vs `DOWNLOAD`), revoke active shares, share files.

3. **Executive (Ban Giám Đốc)**:
   - Account: `admin` (Role EXECUTIVE)
   - Scope: Entire enterprise overview.
   - Permissions: Highest approval authority, CDC Debezium audit logs, ONLY role permitted to upload files with scope `COMPANY` or `CONFIDENTIAL`.

---

## 4. ARCHITECTURAL LOCATION TRANSPARENCY & DATA ISOLATION

- Department nodes all run ONE image, `department-service` (container `dept-<code>`, e.g. `dept-hr`, `dept-acc`, `dept-sales`; behaviour set by `DEPT_CODE`). They are isolated with `DepartmentGuard`: direct cross-department HTTP calls return 403 Forbidden. Reached through the gateway at `/api/dept/<code>/...`.
- Cross-department discovery and sharing operates through `search-engine-service:3003`: federated search fans out to every node in the Department Registry (falling back to the `dms_central` index when a node is down), with Redis cache. Identity (department, role, executive) always comes from the JWT, never from request parameters. New departments join with `scripts/add-department.sh`, without editing existing nodes.
- Do not bypass this boundary; always utilize the approved approval and sharing governance workflow.
