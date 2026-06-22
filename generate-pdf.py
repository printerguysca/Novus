#!/usr/bin/env python3
"""
Soho Blinds — Quote / Invoice PDF Generator
Matches the exact layout from the v1.pdf sample.
Called by server.js: python3 generate-pdf.py <json_file> <output.pdf>
"""
import sys, json, os
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, black, white, gray
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

W, H = letter  # 612 x 792
MARGIN = 50
ORANGE = HexColor('#e8580c')
DARK = HexColor('#333333')
GREY_BG = HexColor('#f0f0f0')
GREY_LINE = HexColor('#cccccc')
LIGHT_GREY = HexColor('#888888')

def fmt(v, dec=2):
    return f"${float(v):,.{dec}f}"

def frac_str(whole, frac):
    FRACS = {0:'', 0.125:'1/8', 0.25:'1/4', 0.375:'3/8', 0.5:'1/2', 0.625:'5/8', 0.75:'3/4', 0.875:'7/8'}
    w = int(float(whole or 0))
    f = float(frac or 0)
    fr = FRACS.get(f, '')
    if fr:
        return f'{w} {fr}"'
    return f'{w}"'

def draw_logo(c, x, y):
    """Draw SOHO BLINDS logo — 4 circles with S, O, H, O"""
    r = 22
    gap = 4
    colors = [DARK, DARK, DARK, DARK]
    letters_top = ['S', 'O']
    letters_bot = ['H', 'O']

    for i, letter_char in enumerate(letters_top):
        cx = x + i * (r*2 + gap) + r
        cy = y - r
        c.setFillColor(DARK)
        c.circle(cx, cy, r, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont('Helvetica-Bold', 18)
        c.drawCentredString(cx, cy - 6, letter_char)

    for i, letter_char in enumerate(letters_bot):
        cx = x + i * (r*2 + gap) + r
        cy = y - r*3 - gap
        c.setFillColor(DARK)
        # Bottom-right circle has a special look (like camera icon)
        c.circle(cx, cy, r, fill=1, stroke=0)
        c.setFillColor(white)
        c.setFont('Helvetica-Bold', 18)
        c.drawCentredString(cx, cy - 6, letter_char)

    # "SOHO BLINDS" text below
    c.setFillColor(DARK)
    c.setFont('Helvetica-Bold', 14)
    total_w = 2 * (r*2 + gap)
    c.drawCentredString(x + total_w/2, y - r*4 - gap - 18, 'SOHO BLINDS')


def draw_page1(c, data):
    doc_type = data.get('doc_type', 'QUOTE').upper()
    q = data['quote']
    items = data.get('items', [])
    hide = q.get('hide_prices', False)

    y = H - MARGIN

    # ── Logo (top left) ──
    draw_logo(c, MARGIN, y)

    # ── QUOTE / INVOICE title (top right) ──
    c.setFillColor(DARK)
    c.setFont('Helvetica-Bold', 36)
    c.drawRightString(W - MARGIN, y - 30, doc_type)

    # Quote number
    c.setFont('Helvetica-Bold', 16)
    c.drawRightString(W - MARGIN, y - 52, q.get('quote_number', ''))

    # Date
    c.setFont('Helvetica', 11)
    c.setFillColor(LIGHT_GREY)
    date_str = q.get('created_at', '')
    if date_str:
        try:
            dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            date_str = dt.strftime('%B %d, %Y')
        except:
            pass
    c.drawRightString(W - MARGIN, y - 70, date_str)

    # Status badge
    status = (q.get('status', 'draft')).upper()
    c.setFont('Helvetica-Bold', 10)
    sw = c.stringWidth(status, 'Helvetica-Bold', 10)
    bx = W - MARGIN - sw - 16
    by = y - 92
    c.setStrokeColor(DARK)
    c.setLineWidth(1)
    c.setFillColor(white)
    c.roundRect(bx, by, sw + 16, 20, 3, fill=1, stroke=1)
    c.setFillColor(DARK)
    c.drawCentredString(bx + (sw + 16)/2, by + 5, status)

    # ── Horizontal line ──
    y_line = y - 120
    c.setStrokeColor(DARK)
    c.setLineWidth(2)
    c.line(MARGIN, y_line, W - MARGIN, y_line)

    # ── Company info ──
    y_info = y_line - 16
    c.setFont('Helvetica', 8)
    c.setFillColor(DARK)
    info = "Soho Blinds · 2 Donald Street · Winnipeg, Manitoba R3L 0K5 · ca · Phone: 2044757646 · Email: info@sohoblinds.ca ·"
    c.drawCentredString(W/2, y_info, info)
    c.drawCentredString(W/2, y_info - 12, "https://sohoblinds.ca")

    # ── Bill To box ──
    y_bill = y_info - 40
    box_h = 100
    c.setFillColor(GREY_BG)
    c.setStrokeColor(GREY_BG)
    c.roundRect(MARGIN, y_bill - box_h, W - 2*MARGIN, box_h, 5, fill=1, stroke=0)

    c.setFillColor(DARK)
    c.setFont('Helvetica-Bold', 13)
    c.drawString(MARGIN + 20, y_bill - 22, 'Bill To:')

    c.setFont('Helvetica-Bold', 12)
    c.drawString(MARGIN + 20, y_bill - 42, q.get('client_name', '—'))

    c.setFont('Helvetica', 10)
    yy = y_bill - 58
    if q.get('client_email'):
        c.drawString(MARGIN + 20, yy, f"Email: {q['client_email']}")
        yy -= 15
    if q.get('client_phone'):
        c.drawString(MARGIN + 20, yy, f"Phone: {q['client_phone']}")
        yy -= 15
    if q.get('client_address'):
        c.drawString(MARGIN + 20, yy, f"Address: {q['client_address']}")

    # ── Line Items Table ──
    y_table = y_bill - box_h - 25

    # Table columns: #, Location, Type, Fabric, Case, Width, Height, Control, LR, Mount, Qty
    cols = [
        ('#', 25), ('Location', 80), ('Type', 55), ('Fabric', 55), ('Case', 45),
        ('Width', 60), ('Height', 60), ('Control', 55), ('LR', 25), ('Mount', 35), ('Qty', 30)
    ]

    total_w = sum(c_w for _, c_w in cols)
    x_start = MARGIN
    row_h = 28
    header_h = 24

    # Header row
    c.setFillColor(GREY_BG)
    c.rect(x_start, y_table - header_h, W - 2*MARGIN, header_h, fill=1, stroke=0)

    c.setFont('Helvetica-Bold', 8)
    c.setFillColor(DARK)
    cx = x_start + 5
    for name, col_w in cols:
        c.drawString(cx, y_table - header_h + 8, name)
        cx += col_w

    # Data rows
    c.setFont('Helvetica', 9)
    y_row = y_table - header_h

    for idx, it in enumerate(items):
        y_row -= row_h

        # Alternating row bg
        if idx % 2 == 1:
            c.setFillColor(HexColor('#fafafa'))
            c.rect(x_start, y_row, W - 2*MARGIN, row_h, fill=1, stroke=0)

        # Bottom border
        c.setStrokeColor(GREY_LINE)
        c.setLineWidth(0.5)
        c.line(x_start, y_row, W - MARGIN, y_row)

        c.setFillColor(DARK)
        c.setFont('Helvetica', 9)
        cx = x_start + 5

        vals = [
            str(idx + 1),
            it.get('location', '—'),
            it.get('blind_type', '—'),
            it.get('fabric_code', it.get('hc_custom', '—')),
            it.get('cassette_colour', '—'),
            frac_str(it.get('width_in', 0), it.get('width_frac', 0)),
            frac_str(it.get('length_in', 0), it.get('length_frac', 0)),
            (it.get('control_type', '—') or '—').replace('motor-tubular', 'Motor Tub.').replace('motor', 'Motor').replace('chain', 'Chain').replace('wand', 'Wand'),
            it.get('lr_side', '—'),
            'In' if it.get('mount_type') == 'in' else 'Out',
            str(it.get('qty', 1))
        ]

        for i, (name, col_w) in enumerate(cols):
            text = vals[i] if i < len(vals) else ''
            # Truncate if too wide
            while c.stringWidth(text, 'Helvetica', 9) > col_w - 6 and len(text) > 1:
                text = text[:-1]
            c.drawString(cx, y_row + 9, text)
            cx += col_w

    # ── Summary section (right-aligned like sample) ──
    y_sum = y_row - 20
    sum_label_x = W - MARGIN - 200
    sum_val_x = W - MARGIN

    msrp = float(q.get('subtotal', 0))
    mk = float(q.get('markup', 0))
    disc_pct = float(q.get('discount_pct', 0))
    upg = float(q.get('upgrades', 0))
    tax_pct = float(q.get('tax_pct', 5))
    total = float(q.get('total', 0))
    paid = float(q.get('amount_paid', 0))

    def sum_row(label, value, bold=False, color=DARK, label_bold=False):
        nonlocal y_sum
        c.setFont('Helvetica-Bold' if label_bold else 'Helvetica', 10)
        c.setFillColor(DARK)
        c.drawRightString(sum_label_x, y_sum, label)
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 10)
        c.setFillColor(color)
        c.drawRightString(sum_val_x, y_sum, value)
        y_sum -= 18

    # MSRP
    sum_row('MSRP:', fmt(msrp), label_bold=True)

    # Markup
    if mk > 0:
        sum_row('Markup:', f'+{fmt(mk)}', label_bold=True)

    # Discount
    if disc_pct > 0:
        disc_amt = (msrp + mk) * disc_pct / 100
        sum_row(f'Discount ({disc_pct}%):', f'-{fmt(disc_amt)}', color=ORANGE, label_bold=True)

    # Upgrades
    if upg > 0:
        sum_row('Upgrades:', f'+{fmt(upg)}', color=ORANGE, label_bold=True)

        # Itemized upgrades: calculate from control types
        motor_qty = sum(int(it.get('qty', 1)) for it in items if (it.get('control_type', '') or '').startswith('motor'))
        cordless_qty = sum(int(it.get('qty', 1)) for it in items if it.get('control_type') == 'cordless')

        if cordless_qty > 0:
            c.setFont('Helvetica', 9)
            c.setFillColor(LIGHT_GREY)
            c.drawRightString(sum_label_x, y_sum, f'Cordless × {cordless_qty} units')
            c.drawRightString(sum_val_x, y_sum, fmt(cordless_qty * 50))
            y_sum -= 16
        if motor_qty > 0:
            c.setFont('Helvetica', 9)
            c.setFillColor(LIGHT_GREY)
            c.drawRightString(sum_label_x, y_sum, f'Motor × {motor_qty} units')
            c.drawRightString(sum_val_x, y_sum, fmt(motor_qty * 200))
            y_sum -= 16

    # Subtotal
    before_disc = msrp + mk
    after_disc = before_disc * (1 - disc_pct/100)
    subtotal = after_disc + upg
    sum_row('Subtotal:', fmt(subtotal), label_bold=True)

    # Tax
    tax_amt = subtotal * tax_pct / 100
    sum_row(f'Tax ({tax_pct:.2f}%):', fmt(tax_amt), label_bold=True)

    # Total line
    c.setStrokeColor(DARK)
    c.setLineWidth(1.5)
    c.line(sum_label_x - 20, y_sum + 14, sum_val_x, y_sum + 14)

    c.setFont('Helvetica-Bold', 13)
    c.setFillColor(DARK)
    c.drawRightString(sum_label_x, y_sum, 'TOTAL:')
    c.drawRightString(sum_val_x, y_sum, fmt(total))
    y_sum -= 22

    # Paid / Balance
    if paid > 0:
        balance = total - paid
        sum_row('Paid:', fmt(paid), label_bold=True, color=HexColor('#16a34a'))
        sum_row('Balance Due:', fmt(balance), bold=True, label_bold=True, color=ORANGE if balance > 0 else HexColor('#16a34a'))


def draw_page2(c, data):
    """Terms and Conditions page — matches sample exactly."""
    q = data['quote']
    doc_type = data.get('doc_type', 'QUOTE').upper()

    y = H - MARGIN

    # ── Terms and Conditions header ──
    c.setFillColor(DARK)
    c.setFont('Helvetica-Bold', 22)
    c.drawString(MARGIN, y - 10, 'Terms and Conditions')

    # Underline
    c.setStrokeColor(DARK)
    c.setLineWidth(1)
    c.line(MARGIN, y - 18, MARGIN + 280, y - 18)

    y -= 50

    # ── Changes ──
    c.setFont('Helvetica-Bold', 14)
    c.drawString(MARGIN, y, 'Changes')
    y -= 18

    changes_text = (
        'Any changes in the original order must be discussed at the Soho Blinds office line at '
        '(204) 475-7646, Monday to Friday 10 am till 4 pm or email at info@sohoblinds.ca '
        'before they could be performed by the technician.'
    )
    y = draw_para(c, changes_text, MARGIN, y, W - 2*MARGIN, 'Helvetica', 10)
    y -= 18

    # ── Warranty & Handling ──
    c.setFont('Helvetica-Bold', 14)
    c.setFillColor(DARK)
    c.drawString(MARGIN, y, 'Warranty & Handling')
    y -= 18

    warranty_text = (
        'Soho Blinds offers warranty of 10 years on the mechanical parts including aluminum '
        'hardware tracks or casings, mechanical clutches, types of manual controls and 1 year '
        'on the motorization parts. Soho Blinds will repair any defects related to mechanical '
        'or hardware parts of the blinds during the 10-year period and motorized parts for '
        'the 1-year period from the date of install. Any other warranties explicitly mentioned '
        'are not valid. Soho Blinds\' Warranty does not cover damage caused by improper use, '
        'improper cleaning, abuse or neglect.'
    )
    y = draw_para(c, warranty_text, MARGIN, y, W - 2*MARGIN, 'Helvetica', 10)
    y -= 18

    # ── Payment ──
    c.setFont('Helvetica-Bold', 14)
    c.setFillColor(DARK)
    c.drawString(MARGIN, y, 'Payment')
    y -= 18

    payment_text = (
        'Deposits for all customized products are non-refundable. Balance payment is due in full '
        'upon installation and completion of the project or the services provided, unless an '
        'installment method is chosen.'
    )
    y = draw_para(c, payment_text, MARGIN, y, W - 2*MARGIN, 'Helvetica', 10)
    y -= 14

    # ── Separator line ──
    c.setStrokeColor(GREY_LINE)
    c.setLineWidth(1)
    c.line(MARGIN, y, W - MARGIN, y)
    y -= 18

    # ── Customer initial section ──
    c.setFont('Helvetica-Bold', 10)
    c.setFillColor(DARK)
    c.drawString(MARGIN, y, 'Please have the Customer initial on the line to confirm critical details for the chosen products:')
    y -= 20

    bullets = [
        'Sheer weave and screen weave blinds do not offer privacy at night when lights are on indoors.',
        'Zebra and Roller Shades will have large gaps in bay/bow window installation.',
        'All inside mount blinds and shades will have light gaps between product and frame to allow for smooth operation.',
        'No products or applications offer 100% light filtration or blackout.',
        'Customer is aware that "gaps" will be prevalent where blinds and shades butt together.',
        'Customer will move all the furniture and obstructions prior to the arrival of the installer.',
        'Customer will remove all existing tracks, blinds and drapes prior to the installer\'s arrival.\n(If required, please consult with your sales representative about surcharges)',
        'Customer will dispose of all garbage associated with the installation.\n(If required, please consult with your sales representative about surcharges)',
    ]

    for bullet in bullets:
        lines = bullet.split('\n')
        c.setFont('Helvetica', 9)
        c.setFillColor(DARK)
        # Bullet dot
        c.drawString(MARGIN + 8, y, '•')
        for j, line in enumerate(lines):
            wrapped = simpleSplit(line, 'Helvetica', 9, W - 2*MARGIN - 25)
            for wl in wrapped:
                if j > 0:
                    c.setFont('Helvetica', 8)
                    c.setFillColor(LIGHT_GREY)
                c.drawString(MARGIN + 22, y, wl)
                y -= 13
        y -= 3

    y -= 6

    # ── Thank you block ──
    c.setFont('Helvetica-Bold', 9)
    c.setFillColor(DARK)
    thank_text = (
        'Thank you for placing your order with Soho Blinds Canada. We will make our best efforts '
        'to ensure that your custom made products are processed in a timely manner. We trust that '
        'you will be satisfied with the product and services we provide.'
    )
    y = draw_para(c, thank_text, MARGIN, y, W - 2*MARGIN, 'Helvetica-Bold', 9)
    y -= 10

    contact_text = (
        'Should you have any questions on your order or require a status update, please feel free '
        'to contact our office at 204-475-7646 (SOHO) or email us at info@sohoblinds.ca'
    )
    y = draw_para(c, contact_text, MARGIN, y, W - 2*MARGIN, 'Helvetica-Bold', 9)
    y -= 10

    # ── Separator ──
    c.setStrokeColor(GREY_LINE)
    c.line(MARGIN, y, W - MARGIN, y)
    y -= 18

    # ── Agreement + initial ──
    c.setFont('Helvetica-Bold', 10)
    c.setFillColor(DARK)
    agree_text = (
        'By initializing this page, customer agrees that you have read and accepted all the terms '
        'and conditions and product information mentioned above.'
    )
    y = draw_para(c, agree_text, MARGIN, y, W - 2*MARGIN, 'Helvetica-Bold', 10)
    y -= 16

    c.setFont('Helvetica-Bold', 11)
    c.drawString(MARGIN, y, 'Initial here: _______________')

    # ── Footer ──
    y_foot = MARGIN + 50
    c.setStrokeColor(GREY_LINE)
    c.setLineWidth(1)
    c.line(MARGIN, y_foot + 20, W - MARGIN, y_foot + 20)

    c.setFont('Helvetica-Bold', 10)
    c.setFillColor(ORANGE)
    c.drawCentredString(W/2, y_foot, 'Thank you for your business!')

    c.setFont('Helvetica', 9)
    c.setFillColor(LIGHT_GREY)
    date_str = q.get('created_at', '')
    try:
        dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        date_str = dt.strftime('%B %d, %Y')
    except:
        pass
    c.drawCentredString(W/2, y_foot - 16, f'{doc_type.capitalize()} generated on {date_str}')
    c.drawCentredString(W/2, y_foot - 32, f'This {doc_type.lower()} is valid for 30 days from the date above.')


def draw_para(c, text, x, y, max_w, font, size):
    """Draw wrapped paragraph, return new y position."""
    c.setFont(font, size)
    c.setFillColor(DARK)
    lines = simpleSplit(text, font, size, max_w)
    for line in lines:
        c.drawString(x, y, line)
        y -= size + 4
    return y


def generate(data, output_path):
    c = canvas.Canvas(output_path, pagesize=letter)
    c.setTitle(f"{data.get('doc_type', 'Quote')} - {data['quote'].get('quote_number', '')}")
    c.setAuthor('Soho Blinds WMS')

    draw_page1(c, data)
    c.showPage()
    draw_page2(c, data)
    c.showPage()
    c.save()


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 generate-pdf.py <input.json> <output.pdf>")
        sys.exit(1)

    with open(sys.argv[1], 'r') as f:
        data = json.load(f)

    generate(data, sys.argv[2])
    print(f"PDF generated: {sys.argv[2]}")
