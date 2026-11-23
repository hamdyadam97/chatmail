"""The employees list as a printable PDF (user decision 2026-11-23): only the
name, the workplace, the sign-in state and — with an announcement filter —
whether they read/acknowledged it. Right to left, header repeated on every page.
Account data only, never any content."""
from apps.approvals.signing import FONT_PATH, _ar

MARGIN = 12.0
ROW_H = 8.0
HEAD_FILL = (31, 58, 104)
STRIPE = (243, 245, 249)


def sign_in_state(u) -> str:
    if not u.is_active:
        return "مؤرشف"
    if u.last_login_at is None:
        return "لم يدخل بعد"
    if u.must_change_password:
        return "لم يغيّر كلمة المرور"
    return "دخل"


def announcement_state(row) -> str:
    if row is not None and row.acknowledged_at:
        return "أقر"
    if row is not None and row.read_at:
        return "اطّلع ولم يقر"
    return "لم يطّلع"


def workplace(membership) -> str:
    if membership is None:
        return "—"
    parts = [membership.institute.name if membership.institute_id else ""]
    if membership.branch_id:
        parts.append(membership.branch.name)
    if membership.department_id:
        parts.append(membership.department.name)
    return " / ".join(p for p in parts if p) or "—"


def build(*, title: str, lines: list[str], header: list[str], rows: list[list[str]], widths: list[float]) -> bytes:
    """`widths` are fractions of the usable width, right-most column first."""
    from fpdf import FPDF

    pdf = FPDF(unit="mm", format="A4")
    pdf.set_auto_page_break(False)
    pdf.set_margins(MARGIN, MARGIN, MARGIN)
    pdf.add_font("Amiri", fname=str(FONT_PATH))
    usable = pdf.w - 2 * MARGIN
    cols = [usable * f for f in widths]

    def fit(text: str, width: float) -> str:
        """Shaped text that fits the cell (cut with an ellipsis)."""
        text = (text or "").replace("\n", " ").strip()
        shaped = _ar(text)
        while text and pdf.get_string_width(shaped) > width - 3:
            text = text[:-1]
            shaped = _ar(text + "…")
        return shaped

    def draw_row(values, *, head=False, fill=None):
        x = pdf.w - MARGIN
        y = pdf.get_y()
        for value, w in zip(values, cols):
            x -= w
            pdf.set_xy(x, y)
            if fill:
                pdf.set_fill_color(*fill)
            pdf.cell(w, ROW_H, fit(value, w), border=0, align="R", fill=bool(fill))
        pdf.set_xy(MARGIN, y + ROW_H)
        if not head:
            pdf.set_draw_color(225, 228, 235)
            pdf.line(MARGIN, y + ROW_H, pdf.w - MARGIN, y + ROW_H)

    def header_row():
        pdf.set_font("Amiri", size=10)
        pdf.set_text_color(255, 255, 255)
        draw_row(header, head=True, fill=HEAD_FILL)
        pdf.set_text_color(25, 25, 25)

    def new_page(first=False):
        pdf.add_page()
        if first:
            pdf.set_font("Amiri", size=16)
            pdf.cell(usable, 10, _ar(title), align="R", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Amiri", size=10)
            pdf.set_text_color(90, 90, 90)
            for line in lines:
                pdf.cell(usable, 6, _ar(line), align="R", new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(25, 25, 25)
            pdf.ln(2)
        header_row()

    new_page(first=True)
    pdf.set_font("Amiri", size=10)
    for i, values in enumerate(rows):
        if pdf.get_y() + ROW_H > pdf.h - MARGIN - 6:
            new_page()
            pdf.set_font("Amiri", size=10)
        draw_row(values, fill=STRIPE if i % 2 else None)
    # page numbers
    total = pdf.page_no()
    pdf.set_font("Amiri", size=8)
    pdf.set_text_color(120, 120, 120)
    for n in range(1, total + 1):
        pdf.page = n
        pdf.set_xy(MARGIN, pdf.h - MARGIN)
        pdf.cell(usable, 5, f"{n} / {total}", align="C")
    return bytes(pdf.output())
