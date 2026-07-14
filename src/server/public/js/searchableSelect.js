import { esc } from './state.js';

export class SearchableSelect {
  constructor(selectEl, { placeholder = 'Search...' } = {}) {
    this.selectEl = selectEl;
    this.placeholder = placeholder;
    this.isMulti = selectEl.hasAttribute('multiple');
    this.isOpen = false;
    this.container = null;
    this.trigger = null;
    this.dropdown = null;
    this.searchInput = null;
    this.optionsContainer = null;
    
    this.init();
  }

  init() {
    // Hide original select
    this.selectEl.style.display = 'none';

    // Create custom UI container
    this.container = document.createElement('div');
    this.container.className = 'searchable-select-container';
    if (this.isMulti) this.container.classList.add('multi');

    // Trigger
    this.trigger = document.createElement('div');
    this.trigger.className = 'searchable-select-trigger';
    this.trigger.innerHTML = `
      <div class="searchable-select-chips"></div>
      <span class="searchable-select-arrow">▼</span>
    `;
    this.container.appendChild(this.trigger);

    // Dropdown
    this.dropdown = document.createElement('div');
    this.dropdown.className = 'searchable-select-dropdown';
    
    // Search input
    const searchBox = document.createElement('div');
    searchBox.className = 'searchable-select-search-box';
    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.className = 'searchable-select-search';
    this.searchInput.placeholder = this.placeholder;
    searchBox.appendChild(this.searchInput);
    this.dropdown.appendChild(searchBox);

    // Options container
    this.optionsContainer = document.createElement('div');
    this.optionsContainer.className = 'searchable-select-options';
    this.dropdown.appendChild(this.optionsContainer);

    this.container.appendChild(this.dropdown);
    this.selectEl.parentNode.insertBefore(this.container, this.selectEl.nextSibling);

    // Bind events
    this.trigger.onclick = (e) => {
      e.stopPropagation();
      if (this.isOpen) {
        this.close();
      } else {
        // Close all other searchable selects first
        document.querySelectorAll('.searchable-select-container.open').forEach(el => {
          if (el !== this.container) el.classList.remove('open');
        });
        this.open();
      }
    };

    this.searchInput.onclick = (e) => e.stopPropagation();
    this.searchInput.oninput = () => this.filterOptions();

    // Document click to close
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) {
        this.close();
      }
    });

    // Populate options
    this.refresh();
  }

  open() {
    this.isOpen = true;
    this.container.classList.add('open');
    this.searchInput.value = '';
    this.filterOptions();
    this.searchInput.focus();
  }

  close() {
    this.isOpen = false;
    this.container.classList.remove('open');
  }

  refresh() {
    this.optionsContainer.innerHTML = '';
    
    const options = Array.from(this.selectEl.options);
    options.forEach((opt, idx) => {
      const div = document.createElement('div');
      div.className = 'searchable-select-option';
      if (opt.selected) div.classList.add('selected');
      div.dataset.value = opt.value;
      div.dataset.index = idx;
      
      let indicator = '';
      if (this.isMulti) {
        indicator = `<span class="check-indicator">${opt.selected ? '✓' : ''}</span>`;
      }
      
      div.innerHTML = `<span>${esc(opt.textContent)}</span>${indicator}`;
      
      div.onclick = (e) => {
        e.stopPropagation();
        this.selectOption(idx);
      };
      
      this.optionsContainer.appendChild(div);
    });

    this.updateTrigger();
  }

  selectOption(index) {
    const opt = this.selectEl.options[index];
    if (!opt) return;

    if (this.isMulti) {
      if (opt.value === 'all') {
        // If "All" is selected, deselect all other options
        Array.from(this.selectEl.options).forEach((o, idx) => {
          o.selected = (idx === index);
        });
      } else {
        // Toggle selected state, and make sure "All" is deselected
        opt.selected = !opt.selected;
        const allOpt = Array.from(this.selectEl.options).find(o => o.value === 'all');
        if (allOpt) allOpt.selected = false;
        
        // If nothing is selected, fall back to "All"
        const anySelected = Array.from(this.selectEl.options).some(o => o.selected);
        if (!anySelected && allOpt) allOpt.selected = true;
      }
      this.refresh();
      this.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      this.selectEl.selectedIndex = index;
      this.close();
      this.refresh();
      this.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  deselectOption(index) {
    const opt = this.selectEl.options[index];
    if (!opt || !this.isMulti) return;

    opt.selected = false;
    
    // If nothing remains selected, default to "All"
    const anySelected = Array.from(this.selectEl.options).some(o => o.selected);
    const allOpt = Array.from(this.selectEl.options).find(o => o.value === 'all');
    if (!anySelected && allOpt) allOpt.selected = true;

    this.refresh();
    this.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  updateTrigger() {
    const chipsContainer = this.trigger.querySelector('.searchable-select-chips');
    chipsContainer.innerHTML = '';

    const selectedOptions = Array.from(this.selectEl.options).filter(o => o.selected);

    if (selectedOptions.length === 0 || (selectedOptions.length === 1 && selectedOptions[0].value === 'all')) {
      const defaultText = this.selectEl.options[0]?.textContent || 'Select...';
      chipsContainer.innerHTML = `<span style="color: var(--muted);">${esc(defaultText)}</span>`;
      return;
    }

    if (this.isMulti) {
      selectedOptions.forEach(opt => {
        const chip = document.createElement('span');
        chip.className = 'searchable-select-chip';
        chip.innerHTML = `
          ${esc(opt.textContent)}
          <span class="searchable-select-chip-remove">&times;</span>
        `;
        
        const idx = Array.from(this.selectEl.options).indexOf(opt);
        chip.querySelector('.searchable-select-chip-remove').onclick = (e) => {
          e.stopPropagation();
          this.deselectOption(idx);
        };
        
        chipsContainer.appendChild(chip);
      });
    } else {
      chipsContainer.innerHTML = `<span>${esc(selectedOptions[0].textContent)}</span>`;
    }
  }

  filterOptions() {
    const query = this.searchInput.value.toLowerCase();
    const optionDivs = this.optionsContainer.querySelectorAll('.searchable-select-option');
    
    optionDivs.forEach(div => {
      const text = div.textContent.toLowerCase();
      if (text.includes(query)) {
        div.classList.remove('hidden');
      } else {
        div.classList.add('hidden');
      }
    });
  }
}

export default SearchableSelect;
