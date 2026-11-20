/* my-favorites 原型共享脚本：深浅色切换 + 字号缩放 + 轻交互 */
(function () {
  // 深浅色：跟随上次选择
  var saved = localStorage.getItem("mf-proto-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);

  // 样式调参台覆盖（00-样式调参台.html 写入）：所有页面自动应用
  // colors 仅作用于浅色主题（深色主题保持原样）；struct 为结构参数（圆角/密度/字号），两主题共用
  try {
    var ov = JSON.parse(localStorage.getItem("mf-overrides") || "{}");
    var c = Object.keys(ov.colors || {}).map(function (k) { return k + ":" + ov.colors[k] + ";"; }).join("");
    var s = Object.keys(ov.struct || {}).map(function (k) { return k + ":" + ov.struct[k] + ";"; }).join("");
    if (c || s) {
      var st = document.createElement("style");
      st.id = "mf-overrides";
      st.textContent = (c ? 'html:not([data-theme="dark"]){' + c + "}" : "") + (s ? ":root{" + s + "}" : "");
      document.head.appendChild(st);
    }
  } catch (e) {}

  // 字号缩放（评审用）：0.9 – 1.6，记住选择
  function applyZoom(z) {
    document.body.style.zoom = z;
    localStorage.setItem("mf-proto-zoom", String(z));
  }

  document.addEventListener("DOMContentLoaded", function () {
    var top = document.querySelector(".proto-top");
    if (top) {
      // 主题切换
      if (!top.querySelector(".theme-toggle")) {
        var btn = document.createElement("button");
        btn.className = "icon-btn theme-toggle";
        btn.title = "切换深浅色";
        btn.textContent = "🌓";
        btn.style.fontSize = "16px";
        btn.addEventListener("click", function () {
          var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
          document.documentElement.setAttribute("data-theme", cur);
          localStorage.setItem("mf-proto-theme", cur);
        });
        top.appendChild(btn);
      }
      // 字号缩放控件（放在主题按钮前）
      if (!top.querySelector(".zoomctl")) {
        var savedZ = parseFloat(localStorage.getItem("mf-proto-zoom") || "1");
        if (savedZ && savedZ !== 1) document.body.style.zoom = savedZ;
        var ctl = document.createElement("div");
        ctl.className = "zoomctl";
        var mk = function (label, fn, title) {
          var b = document.createElement("button");
          b.textContent = label;
          b.title = title;
          b.addEventListener("click", function () {
            var cur = parseFloat(localStorage.getItem("mf-proto-zoom") || "1");
            fn(cur);
          });
          return b;
        };
        ctl.appendChild(mk("A−", function (cur) { applyZoom(Math.max(0.9, Math.round((cur - 0.1) * 10) / 10)); }, "缩小"));
        ctl.appendChild(mk("A", function () { applyZoom(1); }, "恢复 100%"));
        ctl.appendChild(mk("A+", function (cur) { applyZoom(Math.min(1.6, Math.round((cur + 0.1) * 10) / 10)); }, "放大（ iPad 建议 130% 左右）"));
        top.insertBefore(ctl, btn);
      }
    }

    // details 折叠交互：data-fold 组内单开
    document.querySelectorAll("[data-fold]").forEach(function (group) {
      var items = group.querySelectorAll("details");
      items.forEach(function (d) {
        d.addEventListener("toggle", function () {
          if (d.open) items.forEach(function (o) { if (o !== d) o.open = false; });
        });
      });
    });

    // diff 行空格切换（演示用）
    document.querySelectorAll(".diff-r[data-accept]").forEach(function (row) {
      row.addEventListener("click", function () {
        row.dataset.accept = row.dataset.accept === "1" ? "0" : "1";
        row.classList.toggle("rejected", row.dataset.accept === "0");
        var sw = row.querySelector(".accept-sw");
        if (sw) sw.checked = row.dataset.accept === "1";
      });
    });
  });
})();
