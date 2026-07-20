# NutriClinic — Suggested Additional Features

Beyond your spec, these make it feel like a real clinic OS. Grouped by priority.

## High value (strongly recommend for v1–v1.1)

1. **Appointment reminders (SMS / WhatsApp / email).** Biggest no-show reducer. Automated 24h-before + confirm link. Nutrition clinics live and die by no-show rate.
2. **Client-facing booking / portal (light).** Even just a self-booking page + "confirm appointment" link cuts front-desk load. Later: clients view their plan, weight chart, next appointment.
3. **Recurring appointments.** A 3-month program implies weekly/biweekly visits — generate the series at purchase instead of booking one-by-one.
4. **Printable / PDF receipts & invoices** with clinic logo, plus end-of-day cash reconciliation report for the secretary.
5. **Meal plan / diet plan attachment per consultation** (upload PDF or a simple structured plan: meals, calories, macros) so the client leaves with a plan — core to a *nutrition* clinic, not generic.
6. **Waitlist & walk-in handling** in the queue (add unscheduled client, slot into gaps).
7. **Dashboard "needs attention" widget:** expiring packages, unpaid balances over N days, clients with no future appointment, overdue follow-ups.

## Clinical depth (nutrition-specific)

8. **Body-composition & target tracking** beyond weight: waist-to-hip ratio, BMI category bands, ideal-weight range, weekly rate-of-loss flagging (safety).
9. **Photo progress (before/after)** with consent flag, stored securely.
10. **Dietary preferences & restrictions structured** (vegetarian, halal, allergies as tags) so they surface as alerts at consultation start.
11. **Lab results tracking** (cholesterol, glucose, etc.) over time with the same chart treatment as weight.
12. **Consultation templates / quick phrases** so dietitians write notes faster.
13. **Goal milestones & automatic congratulations** (hit −5kg, completed program).

## Operations & money

14. **Package renewal prompt** when sessions run low / package expires (upsell + retention).
15. **Partial-payment plans / installments** with reminders for outstanding balances.
16. **Refunds & adjustments** with audit trail (you can record payments but not corrections yet).
17. **Multi-dietitian scheduling / room resources** and per-dietitian working hours + availability, so booking respects real availability.
18. **Commission / payroll by dietitian** (consultations × rate) feeding the expenses/salary line.
19. **Tax / VAT handling** on payments and reports.
20. **Inventory** for supplements/products if the clinic sells them (turns payments into light POS).

## Platform & trust

21. **Notifications center** (in-app bell): check-ins, new payments, reminders, low sessions.
22. **Data export & GDPR-style tools:** export a single client's full record, and "right to be forgotten" (anonymize) — relevant for health data.
23. **Two-factor auth** for admin (and optionally all staff).
24. **Activity timeline per client** (everything that happened, unified) — great for context and disputes.
25. **Offline-tolerant front desk** (PWA) so check-in/queue survive flaky wifi.
26. **Multi-language UI** (likely Arabic/French/English given the locale) with RTL support.
27. **Multi-branch / multi-clinic** support (add `clinic_id` scoping early — cheap now, expensive later).
28. **Role: "Manager"** between secretary and admin (sees ops + light finance, not staff/settings) — common in real clinics.

## Quality-of-life

29. **Duplicate-client detection** on registration (same phone/email).
30. **Bulk actions** (mark no-shows, send reminders) and **CSV import** for migrating existing client lists.
31. **Audit log search/filter + export** for the admin.
32. **"Today at a glance" print sheet** for the front desk each morning.

---

### Minimum to feel "real" (if you trim scope)
Reminders (1) + recurring appointments (3) + PDF receipts (4) + meal-plan attachment (5) + "needs attention" widget (7) + renewal prompt (14). These six are what separate a clinic OS from a CRUD app, on top of your core spec.
