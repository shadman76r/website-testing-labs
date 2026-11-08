import { jsPDF } from "jspdf";
import type { LabResult, CheckStatus } from "@/lib/types";

const STATUS_COLORS: Record<CheckStatus, [number, number, number]> = {
  PASS: [22, 163, 74],
  FAIL: [220, 38, 38],
  WARNING: [217, 119, 6],
  NOT_CHECKED: [107, 114, 128],
};

function clean(value: string): string {
  return value.replace(/[^\x20-\x7E\u00A0-\u024F]/g, " ").replace(/\s+/g, " ").trim();
}

export function downloadLabPdf(report: LabResult): void {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;
  let y = 18;

  const addHeader = (continuation = false) => {
    doc.setFillColor(10, 20, 36);
    doc.rect(0, 0, pageWidth, 31, "F");
    doc.setTextColor(245, 248, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("WEBSITE TESTING LABS", margin, 13);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(172, 190, 218);
    doc.text(continuation ? `${report.lab.toUpperCase()} · REPORT CONTINUED` : `${report.lab.toUpperCase()} · QA REPORT`, margin, 21);
    doc.setTextColor(40, 50, 65);
    y = 40;
  };

  const ensureSpace = (height: number) => {
    if (y + height > pageHeight - 15) {
      doc.addPage();
      addHeader(true);
    }
  };

  addHeader();
  doc.setTextColor(20, 31, 48);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text(clean(report.pageTitle || report.url).slice(0, 90), margin, y);
  y += 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(85, 101, 125);
  const urlLines = doc.splitTextToSize(clean(report.url), contentWidth);
  doc.text(urlLines, margin, y);
  y += urlLines.length * 4 + 2;
  doc.text(`Completed: ${new Date(report.completedAt).toLocaleString()}   |   Duration: ${(report.durationMs / 1000).toFixed(1)}s   |   Pages scanned: ${report.pagesScanned}`, margin, y);
  y += 9;

  // Summary cards
  const summaryItems: Array<{ label: string; value: number; color: [number, number, number] }> = [
    { label: "PASS", value: report.summary.passed, color: STATUS_COLORS.PASS },
    { label: "FAIL", value: report.summary.failed, color: STATUS_COLORS.FAIL },
    { label: "WARNING", value: report.summary.warnings, color: STATUS_COLORS.WARNING },
    { label: "NOT CHECKED", value: report.summary.notChecked, color: STATUS_COLORS.NOT_CHECKED },
  ];
  const gap = 3;
  const cardWidth = (contentWidth - gap * 3) / 4;
  summaryItems.forEach((item, index) => {
    const x = margin + index * (cardWidth + gap);
    doc.setFillColor(246, 248, 252);
    doc.roundedRect(x, y, cardWidth, 18, 2, 2, "F");
    doc.setFillColor(...item.color);
    doc.roundedRect(x, y, 2, 18, 1, 1, "F");
    doc.setTextColor(...item.color);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.text(item.label, x + 5, y + 6);
    doc.setFontSize(13);
    doc.text(String(item.value), x + 5, y + 14);
  });
  y += 25;

  if (report.scores?.length) {
    ensureSpace(17);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(20, 31, 48);
    doc.text("Quality scores", margin, y);
    y += 6;
    for (const score of report.scores) {
      ensureSpace(10);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(45, 58, 78);
      doc.text(clean(score.label), margin, y + 3);
      const barX = margin + 58;
      const barWidth = contentWidth - 75;
      doc.setFillColor(230, 235, 243);
      doc.roundedRect(barX, y, barWidth, 4, 1, 1, "F");
      const color: [number, number, number] = score.value >= 90 ? [22, 163, 74] : score.value >= 60 ? [217, 119, 6] : [220, 38, 38];
      doc.setFillColor(...color);
      doc.roundedRect(barX, y, barWidth * Math.max(0, Math.min(100, score.value)) / 100, 4, 1, 1, "F");
      doc.setFont("helvetica", "bold");
      doc.text(`${Math.round(score.value)}/100`, margin + contentWidth - 13, y + 3, { align: "right" });
      y += 8;
    }
    y += 3;
  }

  if (report.screenshots.length) {
    ensureSpace(15);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(20, 31, 48);
    doc.text("Visual evidence", margin, y);
    y += 5;
    for (const shot of report.screenshots.slice(0, 4)) {
      try {
        const properties = doc.getImageProperties(shot.dataUrl);
        const maxWidth = contentWidth;
        const maxHeight = 62;
        const scale = Math.min(maxWidth / properties.width, maxHeight / properties.height);
        const imageWidth = properties.width * scale;
        const imageHeight = properties.height * scale;
        ensureSpace(imageHeight + 12);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(80, 95, 116);
        doc.text(clean(shot.label), margin, y + 3);
        y += 5;
        doc.addImage(shot.dataUrl, "JPEG", margin, y, imageWidth, imageHeight, undefined, "FAST");
        y += imageHeight + 6;
      } catch {
        // A corrupt or unsupported image should not prevent the written report from exporting.
      }
    }
  }

  ensureSpace(18);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(20, 31, 48);
  doc.text("Detailed test results", margin, y);
  y += 6;

  for (const check of report.checks) {
    const statusColor = STATUS_COLORS[check.status];
    const title = clean(check.name);
    const expected = doc.splitTextToSize(`Expected: ${clean(check.expected)}`, contentWidth - 4);
    const actual = doc.splitTextToSize(`Actual: ${clean(check.actual)}`, contentWidth - 4);
    const recommendation = check.recommendation ? doc.splitTextToSize(`Recommendation: ${clean(check.recommendation)}`, contentWidth - 4) : [];
    const height = 8 + expected.length * 3.5 + actual.length * 3.5 + recommendation.length * 3.5 + 4;
    ensureSpace(height);
    doc.setFillColor(248, 250, 253);
    doc.roundedRect(margin, y, contentWidth, height, 1.5, 1.5, "F");
    doc.setFillColor(...statusColor);
    doc.roundedRect(margin, y, 2, height, 1, 1, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(25, 38, 58);
    doc.text(title.slice(0, 150), margin + 5, y + 5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.setTextColor(...statusColor);
    doc.text(check.status.replace("_", " "), pageWidth - margin - 4, y + 5, { align: "right" });
    let detailY = y + 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(67, 80, 101);
    doc.text(expected, margin + 5, detailY);
    detailY += expected.length * 3.5;
    doc.text(actual, margin + 5, detailY);
    detailY += actual.length * 3.5;
    if (recommendation.length) {
      doc.setTextColor(90, 102, 122);
      doc.text(recommendation, margin + 5, detailY);
    }
    y += height + 2;
  }

  if (report.notes.length) {
    ensureSpace(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(20, 31, 48);
    doc.text("Scope and limitations", margin, y + 2);
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(85, 101, 125);
    for (const note of report.notes) {
      const lines = doc.splitTextToSize(`• ${clean(note)}`, contentWidth);
      ensureSpace(lines.length * 3.5 + 2);
      doc.text(lines, margin, y);
      y += lines.length * 3.5 + 2;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(120, 132, 150);
    doc.text(`Website Testing Labs · ${page}/${pages}`, pageWidth - margin, pageHeight - 7, { align: "right" });
  }

  const safeLab = report.lab.replace(/[^a-z0-9-]/gi, "-");
  const date = new Date(report.completedAt).toISOString().slice(0, 10);
  doc.save(`website-qa-${safeLab}-${date}.pdf`);
}
