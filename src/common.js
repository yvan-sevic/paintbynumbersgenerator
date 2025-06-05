"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CancellationToken = void 0;
exports.delay = delay;
function delay(ms) {
    if (ms <= 0) {
        return new Promise(function (exec) { return exec(); });
    }
    return new Promise(function (exec) { return setTimeout(exec, ms); });
}
var CancellationToken = /** @class */ (function () {
    function CancellationToken() {
        this.isCancelled = false;
    }
    return CancellationToken;
}());
exports.CancellationToken = CancellationToken;
//# sourceMappingURL=common.js.map