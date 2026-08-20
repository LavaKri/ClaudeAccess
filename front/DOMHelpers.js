export function create (tagName, ...args) {
let tag = document.createElement(tagName);
for (let arg of args) {
if (typeof(arg)=='string') tag.appendChild(document.createTextNode(arg));
else if (typeof(arg)=='object') for (let [attr, val] of Object.entries(arg)) tag.setAttribute(attr, val);
else if (arg instanceof HTMLElement) tag.appendChild(arg);
}
return tag;
}
