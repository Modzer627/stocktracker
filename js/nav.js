// In-app navigation. Deliberately never touches location/history: URL changes
// can kill the camera permission mid-session in iOS home-screen apps.
const screens = new Map();
const stack = [];

export function register(name, view) {
  screens.set(name, view);
}

function sectionOf(name) {
  return document.getElementById(`screen-${name}`);
}

export async function show(name, params = {}, { replace = false } = {}) {
  const current = stack[stack.length - 1];
  if (current) {
    const view = screens.get(current.name);
    if (view && view.hide) await view.hide();
    sectionOf(current.name).hidden = true;
    if (replace) stack.pop();
  }
  stack.push({ name, params });
  sectionOf(name).hidden = false;
  const view = screens.get(name);
  if (view && view.show) await view.show(params);
}

export async function back(fallback = 'home') {
  const leaving = stack.pop();
  if (leaving) {
    const view = screens.get(leaving.name);
    if (view && view.hide) await view.hide();
    sectionOf(leaving.name).hidden = true;
  }
  let target = stack[stack.length - 1];
  if (!target) {
    target = { name: fallback, params: {} };
    stack.push(target);
  }
  sectionOf(target.name).hidden = false;
  const view = screens.get(target.name);
  if (view && view.show) await view.show(target.params);
}

export function currentScreen() {
  return stack[stack.length - 1]?.name || null;
}

export async function resetTo(name, params = {}) {
  const current = stack[stack.length - 1];
  if (current) {
    const view = screens.get(current.name);
    if (view && view.hide) await view.hide();
    sectionOf(current.name).hidden = true;
  }
  stack.length = 0;
  return show(name, params);
}
