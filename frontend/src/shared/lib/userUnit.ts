/** مكان الموظف بجوار اسمه: الفرع، وإلا المعهد. */
export function unitLabel(u: {
  branch?: string | null;
  institute?: string | null;
  primary_membership?: { branch?: string | null; institute?: string | null } | null;
} | null | undefined): string {
  if (!u) return '';
  const m = u.primary_membership;
  return u.branch ?? m?.branch ?? u.institute ?? m?.institute ?? '';
}

/** «الاسم الكامل — الفرع» للنص المسطّح. */
export function nameWithUnit(u: Parameters<typeof unitLabel>[0] & { full_name?: string; username?: string }): string {
  const name = u?.full_name || u?.username || '';
  const unit = unitLabel(u);
  return unit ? `${name} — ${unit}` : name;
}
