import { create } from './DOMHelpers.js';
import { XhrSource } from './XhrSource.js';

async function sendPrompt (event) {
let promptForm = event.target;
let promptField = promptForm.elements.prompt;
let prompt = promptField.value;

event.preventDefault();

promptField.value = '';
alert(prompt);
}


function onWindowLoad () {
let promptForm = document.getElementById('promptForm');
promptForm.addEventListener('submit', sendPrompt);
}

window.addEventListener('load', onWindowLoad);
