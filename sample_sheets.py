import os
import cv2
import numpy as np
from PIL import Image

def generate_answer_sheet(matricula, answers_dict, output_pdf_path, question_count=50):
    """
    Generates a synthetic OMR answer sheet PDF for a student with given answers.
    
    Args:
        matricula (str): Student ID / Matricula.
        answers_dict (dict): Dict of marked answers e.g. {"1": "A", "2": "C", "3": "RAS", "4": "BNK", ...}
        output_pdf_path (str): File path to save output PDF.
    """
    rows = (question_count + 1) // 2
    canvas_w, canvas_h = 1000, rows * 44 + 300
    img = np.ones((canvas_h, canvas_w, 3), dtype=np.uint8) * 255

    # 1. Draw 4 Fiducial Alignment Markers (solid black squares)
    markers = [
        (50, 50),     # TL
        (950, 50),    # TR
        (950, canvas_h - 50),  # BR
        (50, canvas_h - 50)    # BL
    ]
    size = 18
    for (cx, cy) in markers:
        cv2.rectangle(img, (cx - size, cy - size), (cx + size, cy + size), (0, 0, 0), -1)

    # 2. Draw Header
    cv2.putText(img, "SIMULADO ENEM - CARTAO DE RESPOSTAS", (200, 70),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2)
    cv2.putText(img, f"MATRICULA: {matricula}", (200, 110),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (50, 50, 50), 2)
    cv2.line(img, (100, 135), (900, 135), (0, 0, 0), 2)

    # 3. Draw Questions Grid
    options = ['A', 'B', 'C', 'D', 'E']
    y_start = 180
    y_spacing = 44
    col1_x_start = 160
    col1_x_spacing = 45
    col2_x_start = 640
    col2_x_spacing = 45
    radius = 12

    for q in range(1, question_count + 1):
        q_str = str(q)
        if q <= rows:
            col_x_start = col1_x_start
            y = y_start + (q - 1) * y_spacing
        else:
            col_x_start = col2_x_start
            y = y_start + (q - rows - 1) * y_spacing

        # Question label
        cv2.putText(img, f"Q{q:02d}", (col_x_start - 50, y + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)

        # Student marked answer for this question
        marked = answers_dict.get(q_str, 'BNK')

        for opt_idx, opt in enumerate(options):
            cx = col_x_start + opt_idx * (col1_x_spacing if q <= rows else col2_x_spacing)

            # Draw circle outline & option letter inside
            cv2.circle(img, (cx, y), radius, (80, 80, 80), 2)
            cv2.putText(img, opt, (cx - 4, y + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (80, 80, 80), 1)

            # Fill bubble if marked by student
            if marked == opt:
                cv2.circle(img, (cx, y), radius - 1, (0, 0, 0), -1)
            elif marked == 'RAS':
                # Double mark (e.g. A and B filled)
                if opt in ['A', 'B']:
                    cv2.circle(img, (cx, y), radius - 1, (0, 0, 0), -1)

    # 4. Save to PDF using Pillow
    os.makedirs(os.path.dirname(output_pdf_path), exist_ok=True)
    rgb_img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(rgb_img)
    pil_img.save(output_pdf_path, "PDF", resolution=300.0)
    print(f"Gerado: {output_pdf_path}")


if __name__ == "__main__":
    os.makedirs("sample_pdfs", exist_ok=True)

    # Student 1: 100% correct (all match pattern A, B, C, D, E)
    gabarito_padrao = {str(q): ['A', 'B', 'C', 'D', 'E'][(q-1)%5] for q in range(1, 51)}
    generate_answer_sheet("202410101", gabarito_padrao, "sample_pdfs/202410101.pdf")

    # Student 2: Mostly correct, some errors, 1 rasura on Q10, 1 blank on Q20
    resp_student2 = dict(gabarito_padrao)
    resp_student2["10"] = "RAS"
    resp_student2["20"] = "BNK"
    resp_student2["5"] = "E"  # error (official was E or different)
    generate_answer_sheet("202410102", resp_student2, "sample_pdfs/202410102.pdf")

    # Student 3: Random student
    resp_student3 = {str(q): ['A', 'B', 'C', 'D', 'E'][q % 5] for q in range(1, 51)}
    generate_answer_sheet("202410103", resp_student3, "sample_pdfs/202410103.pdf")
