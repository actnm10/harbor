import assert from 'node:assert/strict';

// A small DOM for the shipped renderers: text stays text, fragments are expanded,
// and the actual event handlers run without a browser dependency.
export function createDom(html = '', theme = 'light') {
  const elements = new Map(); let document;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map();
      this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.dataset = {}; this.style = {};
      this.className = ''; this.clientWidth = 640; this.clientHeight = 320; this.scrollTop = 0; this.scrollLeft = 0;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name); this.classList[enabled ? 'add' : 'remove'](name); return enabled; },
      };
    }
    set textContent(value) { this.children = []; this.text = String(value); }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent || '').join(''); }
    set innerHTML(_value) { throw new Error('User content must not be inserted as HTML'); }
    append(...children) {
      for (let child of children) {
        if (typeof child === 'string') child = Object.assign(new Element('#text'), { textContent: child });
        if (child.tagName === '#FRAGMENT') { this.append(...child.children); child.children = []; }
        else { this.children.push(child); child.parent = this; }
      }
    }
    replaceChildren(...children) { this.text = ''; this.children = []; this.append(...children); }
    prepend(...children) { const previous = this.children; this.children = []; this.append(...children); this.children.push(...previous); }
    insertBefore(child, sibling) { const index = this.children.indexOf(sibling); assert.ok(index >= 0); this.children.splice(index, 0, child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, fn) { this.listeners.set(name, [...this.listeners.get(name) || [], fn]); }
    async emit(name, event = {}) { for (const fn of this.listeners.get(name) || []) await fn({ preventDefault() {}, target: this, ...event }); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector.split(',').some(part => {
        const simple = part.trim();
        return simple === '*' || (simple.startsWith('.') ? child.classList.contains(simple.slice(1)) : child.tagName === simple.toUpperCase());
      }));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(child) { return child === this || this.children.some(entry => entry.contains(child)); }
    focus() { document.activeElement = this; }
    select() {} reset() {} scrollIntoView() {}
    click() { void this.emit('click'); }
    getContext() { return {}; }
    pause() {} load() {}
    showModal() { this.open = true; }
    close() { this.open = false; void this.emit('close'); }
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const element = new Element(match[1]); element.id = match[3]; elements.set(element.id, element);
  }
  const $ = id => { assert.ok(elements.has(id), `Missing real HTML element: ${id}`); return elements.get(id); };
  document = {
    documentElement: new Element('html'), body: new Element('body'), activeElement: null, getElementById: $, querySelectorAll: () => [],
    createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
  };
  document.documentElement.dataset.theme = theme;
  return { document, $, Element };
}

export const settle = () => new Promise(resolve => setImmediate(resolve));
