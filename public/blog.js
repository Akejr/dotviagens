// Blog pages: sticky header highlight and the account icon, like the home.
import { stickyHeader } from './api.js';
import { icon } from './icons.js';

document.querySelectorAll('.account>span').forEach(element => { element.innerHTML = icon('user', 16); });
stickyHeader('.header');
